import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Container {
    id: string;
    image: string;
    running: boolean;
    env: string[];
    mounts: { Source: string; Destination: string; RW: boolean }[];
    shmSize: number;
    portBindings: Record<string, { HostIp: string; HostPort: string }[]>;
    labels: Record<string, string>;
}
export interface DockerState {
    containers: Record<string, Container>;
    calls: string[][];
    runFails: boolean;
    data: string | null;
    images: Record<string, { tags: string[]; digests?: string[] }>;
    health?: "healthy" | "unhealthy";
    healthProbes?: string[];
    stopFails?: boolean;
    exitsAfterRun?: boolean;
    sharedVolumeRun?: boolean;
    waitForHandler?: boolean;
    released?: boolean;
    outputBytes?: number;
    /** Registry images by `repo@digest`: pulling one caches that image ID with the digest as its RepoDigest; a missing entry fails. */
    remote?: Record<string, string>;
    imageRemoveFails?: boolean;
    runEnvironment?: Record<string, string | undefined>;
    envFile?: { path: string; mode: number };
    /** Simulates another process: once a call starting with `when` has been seen more than `skip` times, patch management state or move a tag. */
    mutate?: { when: string; skip?: number; management?: Record<string, unknown>; retag?: { tag: string; image: string } };
    /** Registry manifests by exact reference, as `buildx imagetools inspect --format '{{json .Manifest}}'` prints them; a missing reference fails. */
    registry?: Record<string, unknown>;
    buildxMissing?: boolean;
}
export interface StartupResult {
    notifications: { message: string; level: string }[];
    dialogs: { title: string; options?: string[]; message?: string }[];
    tools: string[];
    commands: string[];
}
export interface Fixture {
    root: string;
    envFile(file: string, values: Record<string, string>): void;
    select(name: string): void;
    state(): DockerState;
    setState(state: DockerState): void;
    container(name?: string): Container | undefined;
    management(): Record<string, any> | undefined;
    manage(patch: Record<string, unknown>): void;
    run(steps?: Record<string, unknown>[], overrides?: Record<string, string>): StartupResult;
    apply(overrides?: Record<string, string>): StartupResult;
    cleanup(): void;
}

export const menu = { status: "Status", mode: "Mode", provider: "Provider configuration", apply: "Apply requested configuration", check: "Check for updates" };
export const imageId = "sha256:" + "1".repeat(64);
/** Registry index digest recorded as the cached image's RepoDigest; its host-platform manifest is `platformDigest`. */
export const indexDigest = "sha256:" + "a".repeat(64);
export const platformDigest = "sha256:" + "b".repeat(64);
export function upstreamIndex(index: string, platform: string) {
    const manifest = (digest: string, architecture: string) => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 673, platform: { architecture, os: "linux" } });
    return {
        schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", digest: index, size: 855,
        manifests: [manifest("sha256:" + "e".repeat(64), "s390x"), manifest(platform, process.arch === "arm64" ? "arm64" : "amd64"), { ...manifest("sha256:" + "f".repeat(64), "unknown"), platform: { architecture: "unknown", os: "unknown" } }],
    };
}
/** A newer upstream release of the configured image: its registry digests and the image ID that pulling `pull` caches. */
export const update = { index: "sha256:" + "c".repeat(64), platform: "sha256:" + "d".repeat(64), imageId: "sha256:" + "2".repeat(64), pull: "fixture/image@sha256:" + "d".repeat(64) };
/** Publish `update` in the fake registry and record it as discovered by a manual check. */
export function discoverUpdate(f: Fixture): void {
    const state = f.state();
    state.registry = { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(update.index, update.platform) };
    state.remote = { [update.pull]: update.imageId };
    f.setState(state);
    f.run([{ startup: false, command: true, choices: [menu.check] }]);
}
export const infrastructure = {
    HINDSIGHT_CONTAINER_NAME: "fixture-hindsight",
    HINDSIGHT_IMAGE: "fixture/image:local",
    HINDSIGHT_VOLUME_NAME: "fixture-data",
    HINDSIGHT_WORKER_ID: "fixture-worker",
    HINDSIGHT_API_WORKER_MAX_SLOTS: "2",
    HINDSIGHT_API_PORT: "18888",
    HINDSIGHT_UI_PORT: "19999",
};
export const profile = {
    HINDSIGHT_API_LLM_PROVIDER: "openai",
    HINDSIGHT_API_LLM_MODEL: "fixture-model",
    HINDSIGHT_API_LLM_API_KEY: "synthetic-profile-key",
    HINDSIGHT_API_LLM_STRICT_SCHEMA: "true",
    HINDSIGHT_API_LLM_MAX_CONCURRENT: "3",
};

const fakeDocker = `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2); state.calls.push(args);
if (state.waitForHandler && ["run", "buildx", "pull"].includes(args[0])) {
    const deadline = Date.now() + 1000;
    while (!fs.existsSync(file + ".handler-returned") && Date.now() < deadline) await Bun.sleep(10);
    state.released = fs.existsSync(file + ".handler-returned");
}
const mutation = state.mutate;
if (mutation && state.calls.filter(call => call.join(" ").startsWith(mutation.when)).length > (mutation.skip ?? 0)) {
    delete state.mutate;
    if (mutation.management) {
        const managementFile = path.join(path.dirname(file), ".local-management.json");
        fs.writeFileSync(managementFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(managementFile, "utf8")), ...mutation.management }));
    }
    if (mutation.retag) {
        for (const image of Object.values(state.images)) image.tags = image.tags.filter(tag => tag !== mutation.retag.tag);
        (state.images[mutation.retag.image] ??= { tags: [] }).tags.push(mutation.retag.tag);
    }
}
const findImage = ref => state.images[ref] ? ref : Object.keys(state.images).find(id => state.images[id].tags.includes(ref) || (state.images[id].digests ?? []).includes(ref));
const findContainer = ref => Object.keys(state.containers).find(name => name === ref || state.containers[name].id === ref);
if (state.outputBytes && ["run", "pull"].includes(args[0])) {
    const output = Buffer.alloc(state.outputBytes, "x");
    await Bun.write(Bun.stdout, output); await Bun.write(Bun.stderr, output);
}
let code = 0, out = "", err = "";
switch (args[0]) {
case "version": out = "fixture-server"; break;
case "buildx": {
    if (state.buildxMissing) { code = 1; err = "docker: 'buildx' is not a docker command."; break; }
    if (args[1] === "version") { out = "github.com/docker/buildx fixture"; break; }
    const manifest = args[1] === "imagetools" && args[2] === "inspect" ? state.registry?.[args[3]] : undefined;
    if (!manifest) { code = 1; err = "ERROR: failed to authorize: synthetic-registry-secret"; break; }
    out = JSON.stringify(manifest); break;
}
case "image": {
    const id = findImage(args.at(-1));
    if (!id) { code = 1; break; }
    if (args[1] === "inspect") out = JSON.stringify({ Id: id, RepoTags: state.images[id].tags, RepoDigests: state.images[id].digests ?? [] });
    else if (args[1] === "rm" && !args.includes("--force") && !state.imageRemoveFails && state.images[id].tags.length <= 1 && !Object.values(state.containers).some(container => container.image === id)) delete state.images[id];
    else code = 1;
    break;
}
case "pull": {
    const id = state.remote?.[args[1]];
    if (!id) { code = 1; err = "Error response from daemon: synthetic-registry-secret denied"; break; }
    const image = state.images[id] ??= { tags: [] };
    image.digests = [...new Set([...(image.digests ?? []), args[1]])];
    break;
}
case "tag": {
    const id = findImage(args[1]);
    if (!id) { code = 1; break; }
    for (const image of Object.values(state.images)) image.tags = image.tags.filter(tag => tag !== args[2]);
    state.images[id].tags.push(args[2]); break;
}
case "ps": out = Object.values(state.containers).filter(container => args.at(-1) === "ancestor=" + container.image).map(container => container.id).join("\\n"); break;
case "container": {
    const name = findContainer(args.at(-1));
    if (args[1] !== "inspect" || !name) { code = 1; break; }
    const container = state.containers[name];
    out = JSON.stringify({ Id: container.id, Name: "/" + name, Image: container.image, State: { Running: container.running }, Config: { Labels: container.labels } }); break;
}
case "stop": { const name = findContainer(args.at(-1)); if (!name || state.stopFails) { code = 1; break; } state.containers[name].running = false; break; }
case "start": { const name = findContainer(args.at(-1)); if (!name) { code = 1; break; } state.containers[name].running = true; break; }
case "rename": { const name = findContainer(args[1]); if (!name || state.containers[args[2]]) { code = 1; break; } state.containers[args[2]] = state.containers[name]; delete state.containers[name]; break; }
case "rm": { const name = findContainer(args.at(-1)); if (!name || state.containers[name].running) { code = 1; break; } delete state.containers[name]; break; }
case "volume": if (args[1] === "rm" && args.includes("fixture-data")) state.data = null; else code = 1; break;
case "run": {
    state.runEnvironment = Object.fromEntries(["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"].map(key => [key, process.env[key]]));
    const env = [], mounts = [], portBindings = {}, labels = {};
    let name;
    for (let i = 1; i < args.length; i++) {
        if (args[i] === "--name") name = args[++i];
        if (args[i] === "--label") { const [key, ...value] = args[++i].split("="); labels[key] = value.join("="); }
        if (args[i] === "--env-file") {
            const envFile = args[++i];
            state.envFile = { path: envFile, mode: fs.statSync(envFile).mode & 0o777 };
            env.push(...fs.readFileSync(envFile, "utf8").split("\\n").filter(Boolean));
        }
        if (args[i] === "-v") { const [source, destination, mode] = args[++i].split(":"); mounts.push({ Source: source, Destination: destination, RW: mode !== "ro" }); }
        if (args[i] === "-p") {
            const parts = args[++i].split(":");
            const containerPort = parts.pop(), hostPort = parts.pop();
            portBindings[containerPort + "/tcp"] = [{ HostIp: parts.join(":").replaceAll("[", "").replaceAll("]", ""), HostPort: hostPort }];
        }
    }
    const volume = mounts.find(mount => mount.Destination === "/home/hindsight/.pg0")?.Source;
    if (Object.values(state.containers).some(container => container.running && container.mounts.some(mount => mount.Source === volume))) state.sharedVolumeRun = true;
    const image = findImage(args.at(-1));
    if (state.runFails) { code = 1; err = args.join(" "); }
    else if (!image || !name || state.containers[name]) code = 1;
    else {
        const id = state.calls.length.toString(16).padStart(64, "c");
        state.containers[name] = { id, image, running: !state.exitsAfterRun, env, mounts, portBindings, labels, shmSize: args.includes("--shm-size") ? Number(args[args.indexOf("--shm-size") + 1]) : 67108864 };
        out = id;
    }
    break;
}
default: code = 1;
}
fs.writeFileSync(file, JSON.stringify(state));
if (out) console.log(out); if (err) console.error(err); process.exit(code);`;

const startupDriver = `import fs from "node:fs";
Bun.plugin({ name: "fixture-omp-storage", setup(build) {
    build.module("@oh-my-pi/pi-coding-agent", () => ({ exports: {
        getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? process.env.HOME + "/.omp/agent",
    }, loader: "object" }));
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: { lookup: () => undefined, register: definition => ({ get: () => definition.default }) }, loader: "object" }));
    build.module("@oh-my-pi/pi-natives/vcs", () => ({ exports: { repo: () => undefined }, loader: "object" }));
} });
const stateFile = process.env.FAKE_DOCKER_STATE;
const managementFile = import.meta.dir + "/.local-management.json";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/health") return realFetch(input, init);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    (state.healthProbes ??= []).push(url.host);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const serving = Object.values(state.containers).some(container => container.running && Object.values(container.portBindings).some(bindings => bindings[0]?.HostPort === url.port));
    if (!serving) throw new TypeError("fetch failed");
    const healthy = state.health !== "unhealthy";
    return Response.json(healthy ? { status: "healthy", database: "connected" } : { status: "unhealthy", database: "disconnected" }, { status: healthy ? 200 : 503 });
};
const management = () => { try { return JSON.parse(fs.readFileSync(managementFile, "utf8")); } catch { return undefined; } };
// Background work started by this step: a lease this process held when the handler returned ends with one outcome notification,
// then the lease release; an update check claimed during the step ends with its recorded outcome.
async function settle(since, lease) {
    const reported = notifications.length;
    const deadline = Date.now() + 8000;
    const busy = () => {
        const current = management();
        return (lease?.pid === process.pid && (notifications.length === reported || current?.operation?.id === lease.id))
            || (current?.check?.attemptedAt >= since && !current.check.outcome)
            || fs.existsSync(import.meta.dir + "/.local-management.lock");
    };
    while (busy()) {
        if (Date.now() > deadline) throw new Error("Background lifecycle operation did not finish");
        await Bun.sleep(10);
    }
}
const notifications = [], dialogs = [], tools = [], commands = [];
const steps = JSON.parse(process.env.FIXTURE_STEPS);
for (let i = 0; i < steps.length; i++) {
    const step = steps[i], since = Date.now();
    if (step.selection !== undefined) fs.writeFileSync(import.meta.dir + "/.selected-provider", step.selection);
    const module = await import("./src/hindsight-omp.ts?reload=" + i);
    const startups = [];
    let command;
    module.default({
        pi: { settings: {} },
        getActiveTools() { return []; },
        setLabel() {},
        arktype(schema) { return {}; },
        registerTool(tool) { tools.push(tool.name); },
        on(name, fn) { if (name === "session_start") startups.push(fn); },
        registerCommand(name, options) { commands.push(name); if (name === "hindsight") command = options.handler; },
    });
    const choices = [...(step.choices ?? [])];
    const ctx = { cwd: import.meta.dir, sessionManager: { getBranch: () => [] }, hasUI: step.hasUI ?? true, agent: { kind: step.kind ?? "main" }, ui: {
        notify(message, level) { notifications.push({ message, level }); },
        async select(title, options) {
            dialogs.push({ title, options });
            if (step.removeProfile && fs.existsSync(import.meta.dir + "/providers/" + step.removeProfile + ".env")) fs.unlinkSync(import.meta.dir + "/providers/" + step.removeProfile + ".env");
            return choices.shift();
        },
        async confirm(title, message) {
            dialogs.push({ title, message });
            if (step.afterConfirm) fs.writeFileSync(managementFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(managementFile, "utf8")), ...step.afterConfirm }));
            return step.confirm ?? false;
        },
    } };
    if (step.startup !== false) {
        const readFile = fs.readFileSync;
        if (step.failProfileRead) fs.readFileSync = (file, ...options) => {
            if (String(file).endsWith("/providers/primary.env")) throw new Error("synthetic-sensitive-read-error");
            return readFile(file, ...options);
        };
        try { for (const startup of startups) await startup({}, ctx); }
        finally { fs.readFileSync = readFile; }
    }
    if (step.command) {
        if (!command) throw new Error("Missing /hindsight command");
        if (step.failWrite) fs.chmodSync(import.meta.dir, 0o500);
        try { await command("", ctx); }
        finally { if (step.failWrite) fs.chmodSync(import.meta.dir, 0o700); }
    }
    // Read the lease before releasing waiting fake Docker calls, which may hand it to a simulated competitor.
    const lease = management()?.operation;
    fs.writeFileSync(stateFile + ".handler-returned", "returned");
    await settle(since, lease);
}
console.log(JSON.stringify({ notifications, dialogs, tools, commands }));`;

export function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-test-"));
    fs.cpSync(path.resolve(import.meta.dir, "../src"), path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "providers"));
    fs.mkdirSync(path.join(root, "bin"));
    const statePath = path.join(root, "docker-state.json");
    const managementPath = path.join(root, ".local-management.json");
    fs.writeFileSync(statePath, JSON.stringify({
        containers: {}, calls: [], runFails: false, data: "preserved-data",
        images: { [imageId]: { tags: [infrastructure.HINDSIGHT_IMAGE], digests: ["fixture/image@" + indexDigest] } },
        registry: { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(indexDigest, platformDigest) },
    }));
    fs.writeFileSync(path.join(root, "bin/docker"), fakeDocker, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "driver.ts"), startupDriver);
    function envFile(file: string, values: Record<string, string>) {
        fs.writeFileSync(path.join(root, file), Object.entries(values).map(([k, v]) => k + "=" + v).join("\n") + "\n");
    }
    envFile(".env", infrastructure);
    envFile("providers/primary.env", profile);
    fs.writeFileSync(path.join(root, ".selected-provider"), "primary\n");
    const self: Fixture = {
        root, envFile,
        select(name: string) { fs.writeFileSync(path.join(root, ".selected-provider"), name); },
        state() { return JSON.parse(fs.readFileSync(statePath, "utf8")); },
        setState(state: unknown) { fs.writeFileSync(statePath, JSON.stringify(state)); },
        container(name = infrastructure.HINDSIGHT_CONTAINER_NAME) { return self.state().containers[name]; },
        management() { return fs.existsSync(managementPath) ? JSON.parse(fs.readFileSync(managementPath, "utf8")) : undefined; },
        manage(patch: Record<string, unknown>) {
            fs.writeFileSync(managementPath, JSON.stringify({ version: 1, installationId: "fixture-installation", mode: "off", ...self.management(), ...patch }));
        },
        run(steps: Record<string, unknown>[] = [{}], overrides: Record<string, string> = {}) {
            fs.rmSync(statePath + ".handler-returned", { force: true });
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HINDSIGHT_") && key !== "OLLAMA_API_KEY"));
            // --no-env-file: Bun would otherwise load the cwd's real .env over the fixture's settings.
            const result = Bun.spawnSync([process.execPath, "--no-env-file", path.join(root, "driver.ts")], {
                timeout: 10_000,
                env: { ...env, ...overrides, PATH: path.join(root, "bin") + ":" + process.env.PATH, FAKE_DOCKER_STATE: statePath, FIXTURE_STEPS: JSON.stringify(steps) },
            });
            if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "Fixture run did not finish within ten seconds");
            return JSON.parse(result.stdout.toString());
        },
        apply(overrides: Record<string, string> = {}) {
            self.manage({ mode: "cpu" });
            return self.run([{ startup: false, command: true, choices: [menu.apply], confirm: true }], overrides);
        },
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
    };
    return self;
}

export function nativeEnv(container: Container | undefined): Record<string, string> {
    if (!container) throw new Error("Expected an applied fixture container");
    return Object.fromEntries(container.env.map((entry: string) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
    }));
}
