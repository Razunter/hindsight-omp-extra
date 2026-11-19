import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { computeBankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { isHindsightConfigured, loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { resolveSeedsForScope, seedAlreadyExists } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import { tryAcquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { request } from "./evidence";
import { log } from "./runtime-config";

type Model = { id: string; name: string; tags?: string[]; is_stale?: boolean | null; last_refresh_failed_at?: string | null };
type Finding = { status: "paused" | "stale"; name: string };
type ReadPage = (suffix: string) => Promise<Record<string, unknown>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CADENCE_MS = 24 * HOUR_MS;
const PAGE_CAP = 20;

class CheckError extends Error {
    constructor(readonly category: string) { super(category); }
}

export function registerMentalModelMonitor(pi: ExtensionAPI): void {
    let current: ExtensionContext | undefined;
    pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI !== true || ctx.agent.kind !== "main") return;
        if (current) {
            current = ctx;
            return;
        }
        current = ctx;
        const tick = () => check(pi, current ?? ctx);
        ctx.setTimeout(tick, MINUTE_MS);
        ctx.setInterval(tick, HOUR_MS);
    });
}

async function check(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    let phase = "configuration";
    let failure: string | undefined;
    let lock: FileLockHandle | null | undefined;
    try {
        const settings = pi.pi.settings;
        if (lookup("memory.backend")?.get(settings) !== "hindsight") return;
        const config = loadHindsightConfig(settings);
        if (!isHindsightConfigured(config) || !config.mentalModelsEnabled) return;
        // A timer retains its start context, but the session manager follows /move.
        const scope = computeBankScope(config, ctx.sessionManager.getCwd());
        const seeds = resolveSeedsForScope(scope, config.scoping);
        if (!seeds.length) return;
        const url = new URL(config.hindsightApiUrl);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error("configuration");
        }
        const apiUrl = url.href.replace(/\/+$/, "");
        const target = { apiUrl, bank: scope.bankId, token: config.hindsightApiToken ?? undefined };
        const timeout = config.requestTimeoutMs;
        if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("configuration");

        phase = "storage";
        const dir = path.join(getAgentDir(), "hindsight-mental-model-monitor");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // OMP names the lock after the path string, so every alias of one profile must resolve to one path.
        const root = fs.realpathSync(dir);
        const keyPath = (...parts: string[]) => path.join(root, createHash("sha256").update(JSON.stringify([apiUrl, scope.bankId, ...parts])).digest("hex"));
        // One lock per bank, held for the whole check, so concurrent sessions cannot split one bank's findings across two warnings.
        lock = tryAcquireFileLock(keyPath());
        if (!lock) return;
        const due = seeds.map(seed => ({ seed, record: keyPath(seed.id) + ".json" })).filter(({ record }) => !recent(record));
        if (!due.length) return;

        phase = "request";
        const readPage: ReadPage = async suffix => {
            const signal = AbortSignal.timeout(timeout);
            try { return await request(target, suffix, signal); }
            catch (error) {
                const category = error instanceof Error && "category" in error && typeof error.category === "string" ? error.category : "network";
                throw new CheckError(signal.aborted ? "deadline" : category);
            }
        };
        const models = new Map<string, Model>();
        await pages(readPage, "/mental-models?detail=metadata&exclude_knowledge_pages=true&limit=1000", "items", 1000, value => {
            if (!isModel(value) || models.has(value.id)) throw new CheckError("schema");
            models.set(value.id, value);
        });
        const candidates: Model[] = [];
        for (const { seed } of due) {
            let model = models.get(seed.id);
            for (const id of seed.legacyIds ?? []) {
                if (model) break;
                const candidate = models.get(id);
                if (candidate && seedAlreadyExists(seed, [{ ...candidate, bank_id: scope.bankId }])) model = candidate;
            }
            if (model && status(model)) candidates.push(model);
        }
        const retrying = candidates.length ? await listRetries(readPage) : undefined;
        const findings: Finding[] = [];
        for (const model of candidates) {
            const finding = status(model, retrying);
            if (finding) findings.push({ status: finding, name: model.name || model.id });
        }

        // A warning already shown is better repeated than lost to a failed record write.
        phase = "notification";
        if (findings.length) notify(ctx, scope.bankId, findings);
        phase = "storage";
        const checkedAt = Date.now();
        for (const { record } of due) complete(record, checkedAt);
    } catch (error) {
        failure = error instanceof CheckError ? error.category : phase;
    } finally {
        lock?.release();
        if (failure) log("Mental model check failed:", failure);
    }
}

function status(model: Model, retrying?: ReadonlySet<string>): Finding["status"] | undefined {
    if (retrying?.has(model.id)) return undefined;
    if (model.last_refresh_failed_at) return "paused";
    if (model.is_stale === true) return "stale";
    return undefined;
}

function isModel(value: unknown): value is Model {
    if (typeof value !== "object" || value === null) return false;
    const model = value as Record<string, unknown>;
    return typeof model.id === "string" && model.id.length > 0 && typeof model.name === "string"
        && (model.tags === undefined || (Array.isArray(model.tags) && model.tags.every(tag => typeof tag === "string")))
        && (model.is_stale == null || typeof model.is_stale === "boolean")
        && (model.last_refresh_failed_at == null || typeof model.last_refresh_failed_at === "string");
}

async function pages(readPage: ReadPage, route: string, field: "items" | "operations", requestedLimit: number, visit: (value: unknown) => void): Promise<void> {
    let offset = 0;
    let total: number | undefined;
    for (let index = 0; index < PAGE_CAP; index++) {
        const body = await readPage(`${route}&offset=${offset}`);
        const records = body[field];
        const { limit } = body;
        if (!isCount(body.total) || !Array.isArray(records) || body.offset !== offset || !isCount(limit) || limit < 1 || limit > requestedLimit) throw new CheckError("schema");
        total ??= body.total;
        const end = offset + records.length;
        if (body.total !== total || end > total || records.length > limit || (!records.length && end < total)) throw new CheckError("pagination");
        for (const value of records) visit(value);
        if (end === total) return;
        offset = end;
    }
    throw new CheckError("pagination");
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function listRetries(readPage: ReadPage): Promise<Set<string>> {
    const retrying = new Set<string>();
    // Pending first: a refresh that starts processing between the two reads still shows up in the second.
    for (const status of ["pending", "processing"]) {
        await pages(readPage, `/operations?type=refresh_mental_model&status=${status}&limit=100`, "operations", 100, value => {
            if (typeof value !== "object" || value === null) throw new CheckError("schema");
            const operation = value as Record<string, unknown>;
            if (typeof operation.mental_model_id !== "string" || !operation.mental_model_id || typeof operation.status !== "string") throw new CheckError("schema");
            if (operation.status === "pending" || operation.status === "processing") retrying.add(operation.mental_model_id);
        });
    }
    return retrying;
}

function notify(ctx: ExtensionContext, bank: string, findings: Finding[]): void {
    const paused: string[] = [], stale: string[] = [];
    for (const finding of findings) (finding.status === "paused" ? paused : stale).push(plain(finding.name));
    const lines = [`Hindsight mental models in bank ${plain(bank)}`];
    if (paused.length) lines.push(`Paused: ${paused.join(", ")}. The last refresh failed. Automatic refresh waits until a refresh succeeds.`);
    if (stale.length) lines.push(`Stale: ${stale.join(", ")}. Newer memories exist since the last refresh.`);
    lines.push("You can refresh these models in the Hindsight Control Plane.");
    ctx.ui.notify(lines.join("\n"), "warning");
}

/** Server text with control characters (terminal escapes, line breaks) replaced, so a name cannot restyle or fake warning lines. */
function plain(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/** Atomic write; the caller holds the bank lock, so no other process writes this record meanwhile. */
function complete(record: string, checkedAt: number): void {
    const temporary = record + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ checkedAt }), { mode: 0o600 });
    fs.renameSync(temporary, record);
}

/** An unreadable or malformed record counts as never checked, so the next check overwrites it. */
function recent(record: string): boolean {
    let checkedAt: unknown;
    try { checkedAt = JSON.parse(fs.readFileSync(record, "utf8")).checkedAt; }
    catch { return false; }
    if (typeof checkedAt !== "number") return false;
    const age = Date.now() - checkedAt;
    return age >= 0 && age < CADENCE_MS;
}
