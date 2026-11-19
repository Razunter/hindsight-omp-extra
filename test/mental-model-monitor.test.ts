import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { registerMentalModelMonitor } from "../src/mental-model-monitor";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mental-model-monitor-"));
const day = 24 * 60 * 60 * 1000;
const failure = "2026-01-01T00:00:00Z";
const bank = "team-memory";
const proxies = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let agentDir: string;
const registrars: (typeof registerMentalModelMonitor)[] = [];

type Settings = {
    backend: string;
    hindsightApiUrl: string;
    hindsightApiToken: string;
    mentalModelsEnabled: boolean;
    mentalModelAutoSeed: boolean;
    requestTimeoutMs: number;
    scoping: string;
    bankId: string;
    bankIdPrefix: string;
};
type Seed = { id: string; name: string; sourceQuery: string; tags: string[]; legacyIds?: string[] };
type Model = { id: string; name: string; tags: string[]; is_stale?: boolean | null; last_refresh_failed_at?: string | null; knowledgePage?: boolean };
type Operation = { mental_model_id: string; status: "pending" | "processing"; startsOnProcessingRead?: boolean };
type Bank = { models: Model[]; operations?: Operation[]; failOperations?: boolean; repeatOperationsPage?: boolean };
// OMP's lock conflicts per path across and within processes and is gone once released.
const heldLocks = new Set<string>();

beforeAll(async () => {
    for (const key of ["NO_PROXY", "no_proxy"] as const) process.env[key] = [proxies[key], "127.0.0.1"].filter(Boolean).join(",");
    Bun.plugin({ name: "mental-model-monitor-host", setup(build) {
        build.module("@oh-my-pi/pi-coding-agent", () => ({ exports: { getAgentDir: () => agentDir }, loader: "object" }));
        build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: { lookup: (id: string) => id === "memory.backend" ? { get: (settings: Settings) => settings.backend } : undefined }, loader: "object" }));
        build.module("@oh-my-pi/pi-coding-agent/hindsight/config", () => ({ exports: {
            loadHindsightConfig: (settings: Settings) => settings,
            isHindsightConfigured: (config: Settings) => Boolean(config.hindsightApiUrl),
        }, loader: "object" }));
        build.module("@oh-my-pi/pi-coding-agent/hindsight/bank", () => ({ exports: {
            computeBankScope: (config: Settings, cwd: string) => ({ bankId: `${config.bankIdPrefix}-${config.bankId}`, retainTags: [`project:${path.basename(cwd)}`] }),
        }, loader: "object" }));
        build.module("@oh-my-pi/pi-coding-agent/hindsight/mental-models", () => ({ exports: {
            resolveSeedsForScope: (scope: { retainTags: string[] }, scoping: string) => {
                const seeds: Seed[] = [{ id: "user-preferences", name: "Seed preferences", sourceQuery: "Preferences?", tags: [] }];
                if (scoping === "per-project-tagged") {
                    const project = scope.retainTags[0].slice("project:".length);
                    for (const id of ["project-conventions", "project-decisions"]) {
                        seeds.push({ id: `${id}-${project}`, name: id, sourceQuery: "Project details?", tags: scope.retainTags, legacyIds: [id] });
                    }
                }
                return seeds;
            },
            seedAlreadyExists: (seed: Seed, models: Model[]) => models.some(model => model.id === seed.id ||
                (seed.legacyIds?.includes(model.id) && model.tags.length === seed.tags.length && model.tags.every(tag => seed.tags.includes(tag)))),
        }, loader: "object" }));
        build.module("@oh-my-pi/pi-natives/vcs", () => ({ exports: { repo: () => undefined }, loader: "object" }));
        build.module("@oh-my-pi/pi-utils", () => ({ exports: { tryAcquireFileLock: (file: string) => {
            if (heldLocks.has(file)) return null;
            heldLocks.add(file);
            return { release: () => heldLocks.delete(file) };
        } }, loader: "object" }));
    } });
    // Load after installing the host fakes. The isolated graph keeps evidence and logs separate from other suites.
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    for (const file of ["mental-model-monitor.ts", "evidence.ts", "runtime-config.ts"]) fs.copyFileSync(path.join(import.meta.dir, "../src", file), path.join(src, file));
    fs.copyFileSync(path.join(src, "mental-model-monitor.ts"), path.join(src, "second-monitor.ts"));
    for (const file of ["mental-model-monitor.ts", "second-monitor.ts"]) {
        const { registerMentalModelMonitor } = await import(path.join(src, file));
        registrars.push(registerMentalModelMonitor);
    }
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
        if (proxies[key] === undefined) delete process.env[key]; else process.env[key] = proxies[key];
    }
});

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    setSystemTime();
});

function fixture(banks: Record<string, Bank>) {
    agentDir = fs.mkdtempSync(path.join(root, "profile-"));
    const requests: { bank: string; route: string; offset: number; status: string | null }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const url = new URL(request.url);
        const match = /^\/v1\/default\/banks\/([^/]+)\/(mental-models|operations)$/.exec(url.pathname);
        if (!match || request.method !== "GET" || request.headers.get("Authorization") !== "Bearer fixture-token") return new Response(null, { status: 400 });
        const [, id, route] = match;
        const params = url.searchParams;
        const offset = Number(params.get("offset"));
        const status = params.get("status");
        requests.push({ bank: id, route, offset, status });
        const data = banks[id];
        if (!data) return new Response(null, { status: 404 });
        if (route === "mental-models") {
            if (params.get("detail") !== "metadata" || params.get("limit") !== "1000") return new Response(null, { status: 400 });
            const models = data.models.filter(model => params.get("exclude_knowledge_pages") !== "true" || !model.knowledgePage);
            return Response.json({ items: models.slice(offset, offset + 1000), total: models.length, offset, limit: 1000 });
        }
        if (params.get("type") !== "refresh_mental_model" || params.get("limit") !== "100" || (status !== "pending" && status !== "processing")) return new Response(null, { status: 400 });
        if (data.failOperations) return new Response("private response body", { status: 503 });
        const operations = (data.operations ?? []).filter(operation => operation.status === status);
        // A misbehaving server can answer every offset with its first page.
        const start = data.repeatOperationsPage ? 0 : offset;
        const page = Response.json({ operations: operations.slice(start, start + 100), total: operations.length, offset: start, limit: 100 });
        // A refresh can leave the pending queue and start processing between two listings.
        if (status === "processing") for (const operation of data.operations ?? []) if (operation.startsOnProcessingRead) operation.status = "processing";
        return page;
    } });
    servers.push(server);
    return {
        requests,
        session(project = "alpha", instance = 0) {
            const settings: Settings = { backend: "hindsight", hindsightApiUrl: server.url.href, hindsightApiToken: "fixture-token", mentalModelsEnabled: true,
                mentalModelAutoSeed: false, requestTimeoutMs: 1000, scoping: "per-project-tagged", bankId: "memory", bankIdPrefix: "team" };
            const notifications: { message: string; severity: string }[] = [];
            const timers: { kind: string; callback: () => void | Promise<void>; ms: number }[] = [];
            let start!: (event: { type: "session_start" }, context: typeof ctx) => void | Promise<void>;
            let cwd = `/fixture/${project}`;
            const ctx = {
                cwd: `/fixture/${project}`, hasUI: true, agent: { kind: "main" },
                sessionManager: { getCwd: () => cwd },
                ui: { notify(message: string, severity: string) { notifications.push({ message, severity }); } },
                setTimeout(callback: () => void | Promise<void>, ms: number) { timers.push({ kind: "timeout", callback, ms }); },
                setInterval(callback: () => void | Promise<void>, ms: number) { timers.push({ kind: "interval", callback, ms }); },
            };
            const host = { pi: { settings }, on(name: string, handler: typeof start) { if (name === "session_start") start = handler; } };
            registrars[instance](host as unknown as ExtensionAPI);
            return {
                ctx, notifications, settings, timers,
                move(project: string) { cwd = `/fixture/${project}`; },
                async start() { await start({ type: "session_start" }, ctx); },
                async tick(kind = "timeout") {
                    const timer = timers.find(timer => timer.kind === kind);
                    if (!timer) throw new Error(`Missing ${kind} callback`);
                    await timer.callback();
                },
            };
        },
    };
}

const model = (id: string, fields: Partial<Omit<Model, "id">> = {}): Model => ({ id, name: id, tags: [], ...fields });
const paused = { last_refresh_failed_at: failure, is_stale: true };
const stale = { is_stale: true };

test("warns only for scoped seeds, with Paused before Stale and in-flight refreshes taking precedence", async () => {
    const f = fixture({
        [bank]: { models: [
            model("user-preferences", { ...stale, name: "Saved preferences" }),
            model("project-conventions", { ...paused, tags: ["project:alpha"], name: "Matching legacy conventions" }),
            model("project-decisions", { ...paused, tags: ["project:alpha"], name: "Shadowed legacy decisions" }),
            model("project-decisions-alpha", { ...paused, name: "Qualified decisions" }),
            model("project-decisions-beta", paused),
            model("custom", { ...paused, name: "Seed preferences" }),
            model("project-conventions-alpha", { ...paused, name: "Knowledge page", knowledgePage: true }),
        ] },
        "retry-memory": { models: [
            model("user-preferences", { ...paused, name: "Pending failed" }),
            model("project-conventions-alpha", { ...stale, name: "Processing stale" }),
            model("project-decisions-alpha", { is_stale: false, name: "In sync" }),
        ], operations: [
            { mental_model_id: "user-preferences", status: "pending" },
            { mental_model_id: "project-conventions-alpha", status: "processing" },
        ] },
        "missing-memory": { models: [
            model("user-preferences", { is_stale: null, name: "Unknown status" }),
            model("project-conventions", { ...paused, tags: ["project:beta"], name: "Wrong legacy scope" }),
            model("project-decisions-alpha", { name: "Missing status" }),
        ] },
    });
    const session = f.session();
    await session.start();
    expect(f.requests).toEqual([]);
    await session.tick();
    expect(session.notifications).toHaveLength(1);
    const [{ message, severity }] = session.notifications;
    expect(severity).toBe("warning");
    expect(message).toContain(bank);
    expect(message).toMatch(/Paused:.*Matching legacy conventions.*Qualified decisions[\s\S]*Stale:.*Saved preferences/);
    expect(message).toContain("Hindsight Control Plane");
    for (const name of ["Shadowed legacy decisions", "project-decisions-beta", "Seed preferences", "Knowledge page"]) expect(message).not.toContain(name);

    session.settings.bankIdPrefix = "retry";
    await session.tick("interval");
    expect(session.notifications).toHaveLength(1);
    session.settings.bankIdPrefix = "missing";
    await session.tick("interval");
    expect(session.notifications).toHaveLength(1);
    expect(f.requests.filter(request => request.route === "mental-models").map(request => request.bank)).toEqual([bank, "retry-memory", "missing-memory"]);
    expect(f.requests.filter(request => request.bank === "missing-memory").map(request => request.route)).toEqual(["mental-models"]);

    session.settings.bankIdPrefix = "team";
    session.move("beta");
    await session.tick("interval");
    expect(session.notifications).toHaveLength(2);
    expect(session.notifications[1].message).toContain("project-decisions-beta");
    expect(session.notifications[1].message).not.toContain("Saved preferences");
});

test("follows model pages and suppresses a failed model with a refresh on a later operation page", async () => {
    const f = fixture({ [bank]: {
        models: [...Array.from({ length: 1000 }, (_, index) => model(`custom-${index}`)),
            model("user-preferences", { ...stale, name: "Second page preferences" }), model("project-decisions-alpha", { ...paused, name: "Second page retry" })],
        operations: [...Array.from({ length: 100 }, (_, index) => ({ mental_model_id: `custom-${index}`, status: "processing" as const })),
            { mental_model_id: "project-decisions-alpha", status: "processing" }],
    } });
    const session = f.session();
    await session.start();
    await session.tick();
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0].message).toContain("Second page preferences");
    expect(session.notifications[0].message).not.toContain("Second page retry");
    expect(f.requests).toContainEqual({ bank, route: "mental-models", offset: 1000, status: null });
    expect(f.requests).toContainEqual({ bank, route: "operations", offset: 100, status: "processing" });
});

test("a refresh that starts processing between the two operation listings still counts as in flight", async () => {
    const f = fixture({ [bank]: {
        models: [model("user-preferences", { ...paused, name: "Starting refresh" })],
        operations: [{ mental_model_id: "user-preferences", status: "pending", startsOnProcessingRead: true }],
    } });
    const session = f.session();
    await session.start();
    await session.tick();
    expect(session.notifications).toEqual([]);
    expect(f.requests.filter(request => request.route === "operations").map(request => request.status)).toEqual(["pending", "processing"]);
});

test("a repeated operations page fails the check without recording it", async () => {
    const f = fixture({ [bank]: {
        models: [model("user-preferences", paused)],
        // The page total is a multiple of the page size, so the repeat looks complete and hides the refresh on page two.
        operations: [...Array.from({ length: 199 }, (_, index) => ({ mental_model_id: `custom-${index}`, status: "pending" as const })),
            { mental_model_id: "user-preferences", status: "pending" }],
        repeatOperationsPage: true,
    } });
    const session = f.session();
    await session.start();
    await session.tick();
    expect(session.notifications).toEqual([]);
    expect(fs.readdirSync(path.join(agentDir, "hindsight-mental-model-monitor"))).toEqual([]);
});

test("server-provided names cannot restyle the warning or add lines to it", async () => {
    const f = fixture({ [bank]: { models: [model("user-preferences", { ...stale, name: "Evil\u001b[31m\nPaused: Fake" })] } });
    const session = f.session();
    await session.start();
    await session.tick();
    const [{ message }] = session.notifications;
    expect(message).not.toContain("\u001b");
    expect(message.split("\n").filter(line => line.startsWith("Paused:"))).toEqual([]);
    expect(message).toContain("Evil [31m Paused: Fake");
});

test("an unavailable operations page never warns or consumes the next check", async () => {
    const data = { models: [model("user-preferences", paused)], failOperations: true };
    const f = fixture({ [bank]: data });
    const session = f.session();
    const logFile = path.join(root, "hindsight.log");
    const logLines = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n") : [];
    const earlier = logLines().length;
    await session.start();
    await session.tick();
    expect(session.notifications).toEqual([]);
    expect(fs.readdirSync(path.join(agentDir, "hindsight-mental-model-monitor"))).toEqual([]);
    const log = logLines().slice(earlier);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("http");
    for (const secret of ["private response body", "127.0.0.1", "fixture-token"]) expect(log[0]).not.toContain(secret);
    data.failOperations = false;
    await session.tick("interval");
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0].message).toContain("user-preferences");
    expect(f.requests.filter(request => request.route === "mental-models")).toHaveLength(2);
});

test("shares per-seed cadence through the profile, including across projects and after 24 hours", async () => {
    const now = Date.now();
    setSystemTime(now);
    const f = fixture({ [bank]: { models: [model("user-preferences", stale), model("project-decisions-alpha", stale), model("project-decisions-beta", stale)] } });
    const alpha = f.session();
    const beta = f.session("beta", 1);
    await alpha.start();
    await alpha.tick();
    expect(alpha.notifications).toHaveLength(1);
    expect(alpha.notifications[0].message).toContain("user-preferences");
    expect(alpha.notifications[0].message).toContain("project-decisions-alpha");
    await beta.start();
    await beta.tick();
    expect(beta.notifications).toHaveLength(1);
    expect(beta.notifications[0].message).toContain("project-decisions-beta");
    expect(beta.notifications[0].message).not.toContain("user-preferences");
    const requestCount = f.requests.length;
    setSystemTime(now + day - 1);
    await beta.tick("interval");
    expect(f.requests).toHaveLength(requestCount);
    setSystemTime(now + day);
    await beta.tick("interval");
    expect(beta.notifications).toHaveLength(2);
    expect(beta.notifications[1].message).toContain("user-preferences");
    expect(beta.notifications[1].message).toContain("project-decisions-beta");
});

test("simultaneous monitor instances issue one check and one warning for shared keys", async () => {
    const f = fixture({ [bank]: { models: [model("user-preferences", stale)] } });
    const a = f.session();
    const b = f.session("alpha", 1);
    await Promise.all([a.start(), b.start()]);
    await Promise.all([a.tick(), b.tick()]);
    expect(f.requests.filter(request => request.route === "mental-models")).toHaveLength(1);
    expect([...a.notifications, ...b.notifications]).toHaveLength(1);
});

test("arms once in an interactive main session and reads live eligibility before sending requests", async () => {
    const f = fixture({ [bank]: { models: [model("user-preferences", stale)] } });
    const session = f.session();
    session.ctx.agent.kind = "sub";
    await session.start();
    expect(session.timers).toEqual([]);
    session.ctx.agent.kind = "main";
    session.ctx.hasUI = false;
    await session.start();
    expect(session.timers).toEqual([]);
    session.ctx.hasUI = true;
    await session.start();
    await session.start();
    expect(session.timers.map(({ kind, ms }) => ({ kind, ms }))).toEqual([{ kind: "timeout", ms: 60_000 }, { kind: "interval", ms: 3_600_000 }]);
    session.settings.backend = "off";
    await session.tick();
    session.settings.backend = "hindsight";
    session.settings.mentalModelsEnabled = false;
    await session.tick("interval");
    session.settings.mentalModelsEnabled = true;
    const url = session.settings.hindsightApiUrl;
    session.settings.hindsightApiUrl = "";
    await session.tick("interval");
    expect(f.requests).toEqual([]);
    session.settings.hindsightApiUrl = url;
    await session.tick("interval");
    expect(session.notifications).toHaveLength(1);
});
