import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DockerState {
    container: { env: string[]; mounts: { Source: string; Destination: string; RW: boolean }[]; running: boolean; image: string; shmSize: number; portBindings: Record<string, { HostIp: string; HostPort: string }[]> } | null;
    calls: string[][];
    pullFails: boolean;
    runFails: boolean;
    data: string | null;
    images: Record<string, { tags: string[]; otherContainers: number }>;
    pullImage?: string;
    imageRemoveFails?: boolean;
    waitForStartup?: boolean;
    pullReleased?: boolean;
    pullOutputBytes?: number;
}
export interface StartupResult {
    notifications: { message: string; level: string }[];
    dialogs: { title: string; options: string[] }[];
}
export interface Fixture {
    root: string;
    envFile(file: string, values: Record<string, string>): void;
    select(name: string): void;
    state(): DockerState;
    setState(state: DockerState): void;
    run(steps?: Record<string, unknown>[], overrides?: Record<string, string>): StartupResult;
    cleanup(): void;
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
const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2); state.calls.push(args);
let code = 0, out = "", err = "";
switch (args[0]) {
case "version": out = "fixture-server"; break;
case "pull": {
if (state.waitForStartup) {
const deadline = Date.now() + 1000;
while (!fs.existsSync(file + ".startup-returned") && Date.now() < deadline) await Bun.sleep(10);
state.pullReleased = fs.existsSync(file + ".startup-returned");
}
if (state.pullOutputBytes) {
const output = Buffer.alloc(state.pullOutputBytes, "x");
await Bun.write(Bun.stdout, output); await Bun.write(Bun.stderr, output);
}
if (state.pullFails) { code = 1; break; }
if (state.pullImage) {
for (const image of Object.values(state.images)) image.tags = image.tags.filter(tag => tag !== args[1]);
state.images[state.pullImage] ??= { tags: [], otherContainers: 0 };
state.images[state.pullImage].tags.push(args[1]); out = "Downloaded newer image";
} else out = "Image is up to date"; break;
}
case "image": {
if (args[1] === "ls") { out = Object.keys(state.images).join("\\n"); break; }
const ref = args.at(-1);
const id = state.images[ref] ? ref : Object.keys(state.images).find(id => state.images[id].tags.includes(ref));
if (!id) { code = 1; break; }
const image = state.images[id];
if (args[1] === "inspect") { out = JSON.stringify({ Id: id, RepoTags: image.tags }); break; }
if (args[1] === "rm") {
if (state.imageRemoveFails || image.otherContainers || state.container?.image === id || image.tags.length > 1) code = 1;
else delete state.images[id]; break;
}
code = 1; break;
}
case "ps": { const id = args.at(-1).replace("ancestor=", ""); out = state.container?.image === id || state.images[id]?.otherContainers ? "fixture-container" : ""; break; }
case "inspect": if (!state.container) { code = 1; break; } out = args[2].includes("Config.Env") ? JSON.stringify(state.container.env) : args[2].includes("Mounts") ? JSON.stringify(state.container.mounts.map(mount => ({ ...mount, Type: mount.Destination === "/home/hindsight/.codex" ? "bind" : "volume" }))) : args[2].includes("HostConfig.ShmSize") ? String(state.container.shmSize) : args[2].includes("HostConfig.PortBindings") ? JSON.stringify(state.container.portBindings) : String(state.container.running); break;
case "rm": state.container = null; break;
case "start": state.container.running = true; break;
case "volume": if (args[1] === "rm" && args.includes("fixture-data")) state.data = null; else code = 1; break;
case "run": {
const env = [], mounts = [], portBindings = {};
for (let i = 1; i < args.length; i++) {
if (args[i] === "-e") env.push(args[++i]);
if (args[i] === "-v") { const [source, destination, mode] = args[++i].split(":"); mounts.push({ Source: source, Destination: destination, RW: mode !== "ro" }); }
if (args[i] === "-p") {
const parts = args[++i].split(":");
const containerPort = parts.pop(), hostPort = parts.pop();
portBindings[containerPort + "/tcp"] = [{ HostIp: parts.join(":").replaceAll("[", "").replaceAll("]", ""), HostPort: hostPort }];
}
}
if (state.runFails) { code = 1; err = args.join(" "); } else {
const image = Object.keys(state.images).find(id => state.images[id].tags.includes(args.at(-1)));
if (!image) code = 1; else state.container = { env, mounts, portBindings, running: true, image, shmSize: args.includes("--shm-size") ? Number(args[args.indexOf("--shm-size") + 1]) : 67108864 };
} break;
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
const notifications = [], dialogs = [];
const steps = JSON.parse(process.env.FIXTURE_STEPS);
let started = false, finishStartup;
const startupFinished = new Promise(resolve => { finishStartup = resolve; });
for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.selection !== undefined) fs.writeFileSync(import.meta.dir + "/.selected-provider", step.selection);
    const module = await import("./src/hindsight-omp.ts?reload=" + i);
    const startups = [];
    let command;
    module.default({
        pi: { settings: {} },
        getActiveTools() { return []; },
        setLabel() {},
        arktype(schema) { return {}; },
        registerTool() {},
        on(name, fn) { if (name === "session_start") startups.push(fn); },
        registerCommand(name, options) { if (name === "hindsight-provider") command = options.handler; },
    });
    const ctx = { cwd: import.meta.dir, sessionManager: { getBranch: () => [] }, hasUI: step.hasUI ?? true, agent: { kind: step.kind ?? "main" }, ui: {
        notify(message, level) { notifications.push({ message, level }); },
        async select(title, options) {
            dialogs.push({ title, options });
            if (step.removeProfile) fs.unlinkSync(import.meta.dir + "/providers/" + step.removeProfile + ".env");
            return step.choice;
        },
    } };
    if (step.startup !== false) {
        const readFile = fs.readFileSync;
        if (step.failProfileRead) fs.readFileSync = (file, ...options) => {
            if (String(file).endsWith("/providers/primary.env")) throw new Error("synthetic-sensitive-read-error");
            return readFile(file, ...options);
        };
        try { for (const startup of startups) await startup({}, { ...ctx, ui: { ...ctx.ui, notify(message, level) { ctx.ui.notify(message, level); finishStartup(); } } }); }
        finally { fs.readFileSync = readFile; }
        if (ctx.hasUI && ctx.agent.kind === "main") {
            started = true;
            fs.writeFileSync(process.env.FAKE_DOCKER_STATE + ".startup-returned", "returned");
        }
    }
    if (step.command) {
        if (!command) throw new Error("Missing hindsight-provider command");
        if (step.failWrite) fs.chmodSync(import.meta.dir, 0o500);
        try { await command("", ctx); }
        finally { if (step.failWrite) fs.chmodSync(import.meta.dir, 0o700); }
    }
}
if (started) await startupFinished;
console.log(JSON.stringify({ notifications, dialogs }));`;

export function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-test-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "providers"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.copyFileSync(path.resolve(import.meta.dir, "../src/hindsight-omp.ts"), path.join(root, "src/hindsight-omp.ts"));
    fs.copyFileSync(path.resolve(import.meta.dir, "../src/evidence.ts"), path.join(root, "src/evidence.ts"));
    fs.copyFileSync(path.resolve(import.meta.dir, "../src/recall-assistance.ts"), path.join(root, "src/recall-assistance.ts"));
    const statePath = path.join(root, "docker-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ container: null, calls: [], pullFails: false, runFails: false, data: "preserved-data", images: { ["sha256:" + "1".repeat(64)]: { tags: [infrastructure.HINDSIGHT_IMAGE], otherContainers: 0 } } }));
    fs.writeFileSync(path.join(root, "bin/docker"), fakeDocker, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "driver.ts"), startupDriver);
    function envFile(file: string, values: Record<string, string>) {
        fs.writeFileSync(path.join(root, file), Object.entries(values).map(([k, v]) => k + "=" + v).join("\n") + "\n");
    }
    envFile(".env", infrastructure);
    envFile("providers/primary.env", profile);
    fs.writeFileSync(path.join(root, ".selected-provider"), "primary\n");
    return {
        root, envFile,
        select(name: string) { fs.writeFileSync(path.join(root, ".selected-provider"), name); },
        state() { return JSON.parse(fs.readFileSync(statePath, "utf8")); },
        setState(state: unknown) { fs.writeFileSync(statePath, JSON.stringify(state)); },
        run(steps: Record<string, unknown>[] = [{}], overrides: Record<string, string> = {}) {
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HINDSIGHT_") && key !== "OLLAMA_API_KEY"));
            // --no-env-file: Bun would otherwise load the cwd's real .env over the fixture's settings.
            const result = Bun.spawnSync([process.execPath, "--no-env-file", path.join(root, "driver.ts")], {
                timeout: 5_000,
                env: { ...env, ...overrides, PATH: path.join(root, "bin") + ":" + process.env.PATH, FAKE_DOCKER_STATE: statePath, FIXTURE_STEPS: JSON.stringify(steps) },
            });
            if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "Fixture startup did not finish within five seconds");
            return JSON.parse(result.stdout.toString());
        },
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

export function nativeEnv(state: DockerState): Record<string, string> {
    if (!state.container) throw new Error("Expected an applied fixture container");
    return Object.fromEntries(state.container.env.map((entry: string) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
    }));
}
