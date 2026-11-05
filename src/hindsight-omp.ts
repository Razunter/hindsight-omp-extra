import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerEvidence } from "./evidence";
import { registerRecallAssistance } from "./recall-assistance";

const EXTENSION_ROOT = path.resolve(import.meta.dir, "..");
const HINDSIGHT_ENV_FILE = path.join(EXTENSION_ROOT, ".env");
const LOG_FILE = path.join(EXTENSION_ROOT, "hindsight.log");
const IMAGE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const IMAGE_CHECK_STAMP = path.join(EXTENSION_ROOT, ".last-image-check");
const DOCKER_TIMEOUT = 8_000;
const SHM_SIZE_BYTES = 1024 * 1024 * 1024;
const PROVIDERS_DIR = path.join(EXTENSION_ROOT, "providers");
const SELECTION_FILE = path.join(EXTENSION_ROOT, ".selected-provider");
const MANAGED_NATIVE_SETTINGS = [
    "HINDSIGHT_API_LLM_PROVIDER", "HINDSIGHT_API_LLM_MODEL",
    "HINDSIGHT_API_LLM_API_KEY", "HINDSIGHT_API_LLM_BASE_URL",
    "HINDSIGHT_API_LLM_STRICT_SCHEMA", "HINDSIGHT_API_LLM_MAX_CONCURRENT",
    "HINDSIGHT_API_LLM_DEFAULT_HEADERS", "HINDSIGHT_API_LLM_CODEX_HOME",
    "HINDSIGHT_API_LLM_REASONING_EFFORT",
];
// Reload replaces modules, not this process-lifetime startup decision.
const startupKey = Symbol.for("hindsight-omp.startup-roots");
const processState = globalThis as typeof globalThis & { [startupKey]?: Set<string> };
const startupRoots = processState[startupKey] ??= new Set<string>();

type HindsightSettings = {
    containerName: string;
    image: string;
    workerId: string;
    workerMaxSlots: string;
    nativeEnv: Record<string, string>;
    codexAuthDir?: string;
    volumeName: string;
    apiPort: string;
    uiPort: string;
    bindAddress: string;
};

/** Append a timestamped line to the extension's log file. */
function log(...args: unknown[]): void {
    try {
        const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
        fs.appendFileSync(LOG_FILE, line);
    } catch {
        // best effort
    }
}

/** Epoch ms of the last successful image check; 0 if never checked or unreadable. */
function lastImageCheck(): number {
    try {
        const ts = Number.parseInt(
            fs.readFileSync(IMAGE_CHECK_STAMP, "utf-8").trim(),
            10,
        );
        // NaN, non-positive, or a future stamp (clock skew) → treat as never checked
        return Number.isInteger(ts) && ts > 0 && ts <= Date.now() ? ts : 0;
    } catch {
        return 0; // missing file — first run
    }
}

/** Mark an image check as completed now. */
function recordImageCheck(): void {
    try {
        fs.writeFileSync(IMAGE_CHECK_STAMP, String(Date.now()));
    } catch (err) {
        log("recordImageCheck error:", err);
    }
}

/**
 * Read simple KEY=VALUE entries from an env file.
 */
function readEnvFile(filePath: string): Record<string, string> | undefined {
    const env: Record<string, string> = {};
    try {
        for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
            const match = line.match(
                /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
            );
            if (!match?.[1]) continue;
            const quoted = match[2]?.match(/^(['"])(.*)\1$/);
            env[match[1]] = quoted?.[2] ?? match[2] ?? "";
        }
    } catch {
        return undefined;
    }
    return env;
}

function getHindsightSettings(
    extensionEnv: Record<string, string>,
): { settings?: HindsightSettings; error?: string } {
    let configuration;
    try {
        configuration = selectedProviderConfiguration(extensionEnv);
    } catch (error) {
        return { error: error instanceof Error ? error.message : "Hindsight: could not read selected provider configuration" };
    }
    const { env, nativeEnv, codexAuthDir } = configuration;
    const get = (name: string): string | undefined =>
        Bun.env[name] ?? env[name];
    const containerName = get("HINDSIGHT_CONTAINER_NAME");
    const image = get("HINDSIGHT_IMAGE");
    const workerId = get("HINDSIGHT_WORKER_ID");
    const workerMaxSlots = get("HINDSIGHT_API_WORKER_MAX_SLOTS");
    const volumeName = get("HINDSIGHT_VOLUME_NAME");
    const apiPort = get("HINDSIGHT_API_PORT");
    const uiPort = get("HINDSIGHT_UI_PORT");
    const bindAddress = get("HINDSIGHT_BIND_ADDRESS") ?? "127.0.0.1";
    if (!isIP(bindAddress)) {
        return { error: "Hindsight: HINDSIGHT_BIND_ADDRESS must be an IPv4 or IPv6 address without brackets or a port" };
    }
    const required = {
        HINDSIGHT_CONTAINER_NAME: containerName,
        HINDSIGHT_IMAGE: image,
        HINDSIGHT_WORKER_ID: workerId,
        HINDSIGHT_API_WORKER_MAX_SLOTS: workerMaxSlots,
        HINDSIGHT_VOLUME_NAME: volumeName,
        HINDSIGHT_API_PORT: apiPort,
        HINDSIGHT_UI_PORT: uiPort,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
        return { error: "Hindsight: missing shared settings in .env or process environment: " + missing.join(", ") };
    }
    if (![apiPort, uiPort, nativeEnv.HINDSIGHT_API_PORT ?? "8888", nativeEnv.HINDSIGHT_CP_PORT ?? "9999"].every(port => /^\d+$/.test(port!) && Number(port) >= 1 && Number(port) <= 65535)) {
        return { error: "Hindsight: host and container API/UI ports must be ports from 1 to 65535" };
    }
    if (!/^\d+$/.test(workerMaxSlots!) || !Number.isSafeInteger(Number(workerMaxSlots)) || Number(workerMaxSlots) < 1) {
        return { error: "Hindsight: HINDSIGHT_API_WORKER_MAX_SLOTS must be a positive integer" };
    }
    return { settings: { containerName: containerName!, image: image!, workerId: workerId!, workerMaxSlots: workerMaxSlots!, volumeName: volumeName!, apiPort: apiPort!, uiPort: uiPort!, bindAddress, nativeEnv, codexAuthDir } };
}

function selectedProviderConfiguration(extensionEnv: Record<string, string>): { env: Record<string, string>; nativeEnv: Record<string, string>; codexAuthDir?: string } {
    let name: string;
    try {
        name = fs.readFileSync(SELECTION_FILE, "utf8").trim();
    } catch {
        throw new Error("Hindsight: no saved provider selection; create providers/<name>.env and select its name in .selected-provider");
    }
    const profileEnv = readEnvFile(providerFile(name));
    if (!profileEnv) throw new Error("Hindsight: could not read selected provider file; base-only configuration was not applied");
    const env = { ...extensionEnv, ...profileEnv };
    const providerChanged = env.HINDSIGHT_API_LLM_PROVIDER !== extensionEnv.HINDSIGHT_API_LLM_PROVIDER;
    const endpointChanged = profileEnv.HINDSIGHT_API_LLM_BASE_URL !== undefined && profileEnv.HINDSIGHT_API_LLM_BASE_URL !== extensionEnv.HINDSIGHT_API_LLM_BASE_URL;
    if (providerChanged || endpointChanged) {
        // Models, endpoints and credentials belong to the service they were configured for.
        for (const key of ["HINDSIGHT_API_LLM_MODEL", "HINDSIGHT_API_LLM_API_KEY", "HINDSIGHT_API_LLM_BASE_URL", "HINDSIGHT_API_LLM_DEFAULT_HEADERS", "HINDSIGHT_API_LLM_CODEX_HOME", "HINDSIGHT_OMP_CODEX_AUTH_DIR"]) {
            if (profileEnv[key] === undefined) delete env[key];
        }
    }
    const provider = env.HINDSIGHT_API_LLM_PROVIDER;
    if (!["openai", "anthropic", "opencode-go", "openai-responses", "openai-codex"].includes(provider)) {
        throw new Error("Hindsight: selected profile requires a supported native HINDSIGHT_API_LLM_PROVIDER");
    }
    for (const key of ["HINDSIGHT_API_LLM_MODEL", "HINDSIGHT_API_LLM_STRICT_SCHEMA", "HINDSIGHT_API_LLM_MAX_CONCURRENT"]) {
        if (!env[key]?.trim()) throw new Error("Hindsight: selected profile is missing " + key);
    }
    if (provider !== "openai-codex" && !env.HINDSIGHT_API_LLM_API_KEY?.trim()) {
        throw new Error("Hindsight: selected key-based profile is missing HINDSIGHT_API_LLM_API_KEY");
    }
    if (env.HINDSIGHT_API_LLM_CODEX_HOME !== undefined) {
        throw new Error("Hindsight: configure the host auth directory with HINDSIGHT_OMP_CODEX_AUTH_DIR; the container Codex home is launcher-managed");
    }
    if (!["true", "false"].includes(env.HINDSIGHT_API_LLM_STRICT_SCHEMA)) {
        throw new Error("Hindsight: profile HINDSIGHT_API_LLM_STRICT_SCHEMA must be true or false");
    }
    const concurrency = env.HINDSIGHT_API_LLM_MAX_CONCURRENT;
    if (!/^\d+$/.test(concurrency) || !Number.isSafeInteger(Number(concurrency)) || Number(concurrency) < 1) {
        throw new Error("Hindsight: profile HINDSIGHT_API_LLM_MAX_CONCURRENT must be a positive integer");
    }
    let endpoint: URL | undefined;
    if (env.HINDSIGHT_API_LLM_BASE_URL !== undefined) {
        try {
            endpoint = new URL(env.HINDSIGHT_API_LLM_BASE_URL);
            if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
        } catch {
            throw new Error("Hindsight: profile HINDSIGHT_API_LLM_BASE_URL must be an HTTP(S) URL without embedded credentials");
        }
    }
    let headers: Record<string, string> = {};
    if (env.HINDSIGHT_API_LLM_DEFAULT_HEADERS !== undefined) {
        try {
            headers = JSON.parse(env.HINDSIGHT_API_LLM_DEFAULT_HEADERS);
            if (!headers || typeof headers !== "object" || Array.isArray(headers) ||
                !Object.entries(headers).every(([key, value]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value))) throw new Error();
        } catch {
            throw new Error("Hindsight: profile HINDSIGHT_API_LLM_DEFAULT_HEADERS must be a JSON object of valid string headers");
        }
    }
    const isGo = provider === "opencode-go" || (endpoint?.hostname === "opencode.ai" && endpoint.pathname.startsWith("/zen/go"));
    if (isGo) {
        const expected = provider === "anthropic" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen/go/v1";
        if (endpoint?.href.replace(/\/$/, "") !== expected || env.HINDSIGHT_API_LLM_MODEL.includes("/")) {
            throw new Error("Hindsight: Go profiles require a bare model ID and the SDK endpoint for their native protocol (Messages: /zen/go; Chat/Responses: /zen/go/v1)");
        }
        if (provider === "anthropic" && !Object.entries(headers).some(([key, value]) => key.toLowerCase() === "user-agent" && value.trim())) {
            throw new Error("Hindsight: Go Messages profiles require an application-specific User-Agent in HINDSIGHT_API_LLM_DEFAULT_HEADERS");
        }
    }
    const codexAuthDir = provider === "openai-codex" ? codexAuthDirectory(env.HINDSIGHT_OMP_CODEX_AUTH_DIR) : undefined;
    const nativeEnv = { ...env };
    if (codexAuthDir) nativeEnv.HINDSIGHT_API_LLM_CODEX_HOME = "/home/hindsight/.codex";
    return { env, nativeEnv, codexAuthDir };
}

function codexAuthDirectory(value: string | undefined): string {
    if (!value || !path.isAbsolute(value) || value.includes(":")) {
        throw new Error("Hindsight: native Codex requires an absolute HINDSIGHT_OMP_CODEX_AUTH_DIR directory path without colons");
    }
    try {
        const directory = fs.realpathSync(value);
        const home = path.resolve(Bun.env.HOME ?? "~");
        const agentRoot = path.join(home, ".omp", "agent");
        const protectedRoots = [agentRoot, path.resolve(getAgentDir())];
        for (const root of [...protectedRoots]) {
            if (fs.existsSync(root)) protectedRoots.push(fs.realpathSync(root));
        }
        const containsOmpStorage = protectedRoots.some(root => root === directory || root.startsWith(directory + path.sep));
        if (directory === path.parse(directory).root || directory.includes(":") || containsOmpStorage) throw new Error();
        const stat = fs.statSync(directory);
        if (!stat.isDirectory() || (stat.mode & 0o222) === 0) throw new Error();
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        const authFile = path.join(directory, "auth.json");
        if (!fs.lstatSync(authFile).isFile()) throw new Error();
        fs.accessSync(authFile, fs.constants.R_OK);
        const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
        if (![auth?.tokens?.access_token, auth?.tokens?.refresh_token].every(token => typeof token === "string" && token.trim())) throw new Error();
        return directory;
    } catch {
        throw new Error("Hindsight: Codex needs a dedicated readable/writable directory that does not contain OMP storage, with readable auth.json containing native access and refresh tokens; authorize it independently and check permissions");
    }
}

function providerNames(): string[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(PROVIDERS_DIR);
    } catch {
        throw new Error("Hindsight: create readable providers/<name>.env configurations before selecting a provider");
    }
    return entries.filter(entry => entry.endsWith(".env")).map(entry => entry.slice(0, -4)).filter(name => {
        try { providerFile(name); return true; }
        catch { return false; }
    }).sort();
}

function saveProviderSelection(name: string): void {
    providerFile(name);
    const temporary = SELECTION_FILE + "." + randomUUID();
    let created = false;
    try {
        const file = fs.openSync(temporary, "wx", 0o600);
        created = true;
        try { fs.writeFileSync(file, name + "\n"); }
        finally { fs.closeSync(file); }
        fs.renameSync(temporary, SELECTION_FILE);
    } catch {
        throw new Error("Hindsight: could not save provider selection; check extension-root write permissions. Previous choice preserved.");
    } finally {
        if (created && fs.existsSync(temporary)) {
            try { fs.unlinkSync(temporary); }
            catch { log("Could not remove owned temporary selection record"); }
        }
    }
}

function providerFile(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error("Hindsight: provider name must contain only letters, digits, underscores or hyphens, starting with a letter or digit");
    }
    try {
        const directory = fs.realpathSync(PROVIDERS_DIR);
        const root = fs.realpathSync(EXTENSION_ROOT);
        const file = fs.realpathSync(path.join(directory, name + ".env"));
        if (path.dirname(directory) !== root || path.dirname(file) !== directory || !fs.statSync(file).isFile()) throw new Error();
        fs.accessSync(file, fs.constants.R_OK);
        return file;
    } catch {
        throw new Error("Hindsight: selected profile must be a readable file contained in the extension providers/ directory");
    }
}

function desiredContainerEnv(settings: HindsightSettings): Record<string, string> {
    return {
        HINDSIGHT_CP_DATAPLANE_API_URL: `http://localhost:${settings.nativeEnv.HINDSIGHT_API_PORT ?? "8888"}`,
        ...settings.nativeEnv,
        ...(settings.codexAuthDir ? { HINDSIGHT_OMP_CODEX_AUTH_DIR: settings.codexAuthDir } : {}),
        HINDSIGHT_OMP_MANAGED_ENV: Object.keys(settings.nativeEnv).sort().join(","),
        HINDSIGHT_API_WORKER_ID: settings.workerId,
        HINDSIGHT_API_WORKER_MAX_SLOTS: settings.workerMaxSlots,
        // Docker-only identity participates in immutable configuration comparison.
        HINDSIGHT_OMP_IMAGE: settings.image,
        HINDSIGHT_OMP_VOLUME_NAME: settings.volumeName,
        HINDSIGHT_OMP_API_PORT: settings.apiPort,
        HINDSIGHT_OMP_UI_PORT: settings.uiPort,
        HINDSIGHT_OMP_BIND_ADDRESS: settings.bindAddress,
    };
}

/**
 * Return whether the existing container has the managed environment, shared memory, published ports, and Codex mount.
 * Extra variables supplied by the image are intentionally ignored.
 */
async function containerConfigMatches(
    containerName: string,
    desired: Record<string, string>,
    codexAuthDir: string | undefined,
): Promise<boolean | null> {
    const inspect = await docker([
        "inspect",
        "-f",
        "{{json .Config.Env}}",
        containerName,
    ]);
    if (inspect.exitCode !== 0) return null;

    try {
        const env: Record<string, string> = {};
        for (const entry of JSON.parse(inspect.stdout) as string[]) {
            const separator = entry.indexOf("=");
            if (separator > 0)
                env[entry.slice(0, separator)] = entry.slice(separator + 1);
        }

        const managed = new Set([...MANAGED_NATIVE_SETTINGS, ...(env.HINDSIGHT_OMP_MANAGED_ENV?.split(",") ?? []), ...Object.keys(desired)]);
        if (![...managed].every(key => env[key] === desired[key])) return false;
        const inspectShm = await docker(["inspect", "-f", "{{.HostConfig.ShmSize}}", containerName]);
        if (inspectShm.exitCode !== 0 || Number(inspectShm.stdout.trim()) !== SHM_SIZE_BYTES) return false;
        const inspectPorts = await docker(["inspect", "-f", "{{json .HostConfig.PortBindings}}", containerName]);
        if (inspectPorts.exitCode !== 0) return false;
        const portBindings = JSON.parse(inspectPorts.stdout);
        for (const [containerPort, hostPort] of [
            [desired.HINDSIGHT_API_PORT ?? "8888", desired.HINDSIGHT_OMP_API_PORT],
            [desired.HINDSIGHT_CP_PORT ?? "9999", desired.HINDSIGHT_OMP_UI_PORT],
        ]) {
            const bindings = portBindings[containerPort + "/tcp"];
            if (!Array.isArray(bindings) || bindings.length !== 1 ||
                bindings[0]?.HostIp !== desired.HINDSIGHT_OMP_BIND_ADDRESS || bindings[0]?.HostPort !== hostPort) return false;
        }
        const inspectMounts = await docker(["inspect", "-f", "{{json .Mounts}}", containerName]);
        if (inspectMounts.exitCode !== 0) return false;
        const mounts = JSON.parse(inspectMounts.stdout) as { Type: string; Destination: string; RW: boolean }[];
        const authMounts = mounts.filter(mount => mount.Destination === "/home/hindsight/.codex");
        // Docker Desktop rewrites Source; canonical host identity is compared in the managed environment.
        return codexAuthDir === undefined
            ? authMounts.length === 0
            : authMounts.length === 1 && authMounts[0].Type === "bind" && authMounts[0].RW === true;
    } catch {
        log("Failed to parse inspected container configuration");
        return false;
    }
}

/**
 * Run a docker command with an abort timeout.
 * Returns { exitCode, stdout, stderr }.  On abort/kill, exitCode is null.
 */
// ponytail: docker-specific helper; hoist if another provider needs the same pattern
async function docker(
    args: string[],
    timeout = DOCKER_TIMEOUT,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(timeout),
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode: proc.exitCode, stdout, stderr };
}

async function startContainer(
    settings: HindsightSettings,
): Promise<boolean> {
    const cleanupImages: { id: string; tags: string[] }[] = [];
    try {
        const env = desiredContainerEnv(settings);

        // 0 — quick Docker reachability check (fail fast)
        const alive = await docker(
            ["version", "--format", "{{.Server.Version}}"],
            5_000,
        );
        if (alive.exitCode !== 0) {
            log("Docker daemon not reachable; exit code:", alive.exitCode);
            return false;
        }

        // 0.5 — pull latest image, at most once per IMAGE_CHECK_INTERVAL_MS
        let imageUpdated = false;
        const previousImage = await inspectImage(settings.image);
        const lastCheck = lastImageCheck();
        const sinceCheck = Date.now() - lastCheck;
        if (previousImage && lastCheck > 0 && sinceCheck < IMAGE_CHECK_INTERVAL_MS) {
            const hours = Math.round(
                (IMAGE_CHECK_INTERVAL_MS - sinceCheck) / 3_600_000,
            );
            log(`Image check skipped, next in ~${hours}h`);
        } else {
            const inventory = await docker(["image", "ls", "--all", "--quiet", "--no-trunc"]);
            if (inventory.exitCode !== 0) throw new Error("Could not establish image ownership before pull");
            const existingIds = new Set(inventory.stdout.trim().split(/\s+/));
            const pull = await docker(["pull", settings.image], 120_000);
            const currentImage = await inspectImage(settings.image);
            if (currentImage) {
                imageUpdated = previousImage?.Id !== currentImage.Id;
                if (previousImage && imageUpdated) cleanupImages.push({ id: previousImage.Id, tags: [] });
                if (!existingIds.has(currentImage.Id)) cleanupImages.push({ id: currentImage.Id, tags: currentImage.RepoTags });
            }
            if (pull.exitCode !== 0) {
                // A failed pull must retry in a fresh process, without advancing the stamp.
                log("Image pull failed; exit code:", pull.exitCode);
            } else {
                if (!currentImage) throw new Error("Pulled image could not be inspected");
                recordImageCheck();
                if (imageUpdated) log("Image updated to latest");
            }
        }

        // Docker cannot update Config.Env in place, so a settings mismatch
        // requires recreation. A newly pulled image is also applied now.
        const configMatches = await containerConfigMatches(
            settings.containerName,
            env,
            settings.codexAuthDir,
        );
        if (configMatches === false || (imageUpdated && configMatches === true)) {
            log(
                imageUpdated && configMatches === true
                    ? "Image updated, removing and recreating container"
                    : "Container settings changed, removing and recreating",
            );
            const remove = await docker(["rm", "-f", settings.containerName]);
            if (remove.exitCode !== 0) {
                log(
                    "Failed to remove container with stale settings:",
                    remove.exitCode,
                );
                return false;
            }
        } else if (configMatches === true) {
            const inspectRunning = await docker([
                "inspect",
                "-f",
                "{{.State.Running}}",
                settings.containerName,
            ]);
            if (
                inspectRunning.exitCode === 0 &&
                inspectRunning.stdout.trim() === "true"
            ) {
                return true;
            }

            const start = await docker(["start", settings.containerName]);
            if (start.exitCode === 0) return true;
            // start failed (e.g. WSL2/Docker Desktop mount path broke) — remove and recreate
            log("docker start failed, removing and recreating; exit code:", start.exitCode);
            await docker(["rm", "-f", settings.containerName]);
        }

        // 2 — doesn't exist (or was recreated): create the container.
        const bindAddress = settings.bindAddress.includes(":") ? "[" + settings.bindAddress + "]" : settings.bindAddress;
        const run = await docker(
            [
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                settings.containerName,
                "--restart",
                "unless-stopped",
                "--shm-size",
                String(SHM_SIZE_BYTES),
                "-p",
                `${bindAddress}:${settings.apiPort}:${env.HINDSIGHT_API_PORT ?? "8888"}`,
                "-p",
                `${bindAddress}:${settings.uiPort}:${env.HINDSIGHT_CP_PORT ?? "9999"}`,
                ...Object.entries(env).flatMap(([key, value]) => [
                    "-e",
                    `${key}=${value}`,
                ]),
                "-v",
                `${settings.volumeName}:/home/hindsight/.pg0`,
                ...(settings.codexAuthDir ? ["-v", settings.codexAuthDir + ":/home/hindsight/.codex:rw"] : []),
                settings.image,
            ],
            60_000,
        ); // longer for image pull

        if (run.exitCode !== 0) {
            log("docker run failed; exit code:", run.exitCode);
            return false;
        }

        log("Container created and started");
        return true;
    } catch {
        log("Container startup transport failed; check Docker availability and permissions");
        return false;
    } finally {
        let cleanupFailed = false;
        for (const image of cleanupImages) {
            try { if (!await removeUnusedImage(image)) cleanupFailed = true; }
            catch { cleanupFailed = true; }
        }
        if (cleanupFailed) {
            log("Managed image cleanup failed; inspect Docker image ownership/permissions before the next fresh startup");
            return false;
        }
    }
}

async function inspectImage(reference: string): Promise<{ Id: string; RepoTags: string[] } | undefined> {
    const result = await docker(["image", "inspect", "--format", "{{json .}}", reference]);
    if (result.exitCode !== 0) return undefined;
    const image = JSON.parse(result.stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || !Array.isArray(image.RepoTags ?? [])) throw new Error("Invalid image metadata");
    return { Id: image.Id, RepoTags: image.RepoTags ?? [] };
}

async function removeUnusedImage(candidate: { id: string; tags: string[] }): Promise<boolean> {
    const image = await inspectImage(candidate.id);
    if (!image) return false;
    if (image.RepoTags.some(tag => !candidate.tags.includes(tag))) return true;
    const containers = await docker(["ps", "--all", "--quiet", "--filter", "ancestor=" + candidate.id]);
    if (containers.exitCode !== 0) return false;
    if (containers.stdout.trim()) return true;
    // No force or parent pruning: other containers/references win a concurrent race.
    const removed = await docker(["image", "rm", "--no-prune", candidate.id]);
    return removed.exitCode === 0;
}

/**
 * omp extension factory.
 */
export default function hindsightPlugin(pi: ExtensionAPI): void {
    pi.setLabel("Hindsight");
    registerEvidence(pi);
    registerRecallAssistance(pi);

    pi.registerCommand("hindsight-provider", {
        description: "Select Hindsight’s provider configuration for the next fresh OMP process",
        handler: async (_args, ctx) => {
            if (ctx.hasUI !== true) return;
            try {
                const names = providerNames();
                if (names.length === 0) {
                    ctx.ui.notify("Hindsight: no contained provider profiles; create providers/<name>.env first", "error");
                    return;
                }
                const selected = await ctx.ui.select("Hindsight provider — next fresh process", names);
                if (selected === undefined) return;
                if (!names.includes(selected)) {
                    ctx.ui.notify("Hindsight: unknown provider selection; previous choice preserved", "error");
                    return;
                }
                saveProviderSelection(selected);
                ctx.ui.notify("Hindsight: selected " + selected + "; applies in the next fresh OMP process.", "info");
            } catch {
                ctx.ui.notify("Hindsight: could not select/save provider; check contained profiles and extension-root write permissions. Previous choice preserved.", "error");
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        // Subagents reuse the shared container; only an interactive root
        // session may reconcile or create it.
        if (ctx.hasUI !== true || ctx.agent.kind !== "main") return;
        const root = fs.realpathSync(EXTENSION_ROOT);
        if (startupRoots.has(root)) return;
        startupRoots.add(root);

        const extensionEnv = readEnvFile(HINDSIGHT_ENV_FILE) ?? {};
        const { settings, error } = getHindsightSettings(extensionEnv);
        if (!settings) {
            ctx.ui.notify(error ?? "Hindsight: invalid settings", "error");
            return;
        }

        // Docker pulls may exceed the host's 30-second extension-handler deadline.
        void startContainer(settings).then(ok => {
            ctx.ui.notify(
                ok
                    ? `Hindsight: container ready (API :${settings.apiPort}, UI :${settings.uiPort})`
                    : "Hindsight: container/image reconciliation failed — check extension's hindsight.log for details",
                ok ? "info" : "error",
            );
        }).catch(() => log("Could not report background container reconciliation result"));
    });
}
