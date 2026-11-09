import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export const EXTENSION_ROOT = path.resolve(import.meta.dir, "..");
export const SHM_SIZE_BYTES = 1024 * 1024 * 1024;
const HINDSIGHT_ENV_FILE = path.join(EXTENSION_ROOT, ".env");
const LOG_FILE = path.join(EXTENSION_ROOT, "hindsight.log");
const PROVIDERS_DIR = path.join(EXTENSION_ROOT, "providers");
const SELECTION_FILE = path.join(EXTENSION_ROOT, ".selected-provider");

export type HindsightSettings = {
    provider: string;
    containerName: string;
    image: string;
    volumeName: string;
    apiPort: string;
    uiPort: string;
    bindAddress: string;
    codexAuthDir?: string;
    /** Complete container environment, including credentials; only ever written to the 0600 env file. */
    env: Record<string, string>;
    /** Identity of the desired container environment and run shape. */
    configDigest: string;
};

/** Append a timestamped line to the extension's log file. */
export function log(...args: unknown[]): void {
    try {
        const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
        fs.appendFileSync(LOG_FILE, line);
    } catch {
        // best effort
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

/** Saved provider configuration name, without validating it. */
export function savedProviderSelection(): string | undefined {
    try {
        return fs.readFileSync(SELECTION_FILE, "utf8").trim();
    } catch {
        return undefined;
    }
}

/** Resolve and validate the requested runtime configuration from local files and the process environment. */
export function resolveSettings(): { settings?: HindsightSettings; error?: string } {
    const extensionEnv = readEnvFile(HINDSIGHT_ENV_FILE) ?? {};
    let configuration;
    try {
        configuration = selectedProviderConfiguration(extensionEnv);
    } catch (error) {
        return { error: error instanceof Error ? error.message : "Hindsight: could not read selected provider configuration" };
    }
    const { provider, env, nativeEnv, codexAuthDir } = configuration;
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
    const containerEnv: Record<string, string> = {
        HINDSIGHT_CP_DATAPLANE_API_URL: `http://localhost:${nativeEnv.HINDSIGHT_API_PORT ?? "8888"}`,
        ...nativeEnv,
        ...(codexAuthDir ? { HINDSIGHT_OMP_CODEX_AUTH_DIR: codexAuthDir } : {}),
        HINDSIGHT_API_WORKER_ID: workerId!,
        HINDSIGHT_API_WORKER_MAX_SLOTS: workerMaxSlots!,
    };
    if (Object.values(containerEnv).some(value => /[\r\n]/.test(value))) {
        return { error: "Hindsight: configuration values must not contain line breaks" };
    }
    const shape = {
        containerName, image, volumeName, apiPort, uiPort, bindAddress,
        codexAuthDir: codexAuthDir ?? null, shmSize: SHM_SIZE_BYTES,
        env: Object.entries(containerEnv).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    };
    return {
        settings: {
            provider, containerName: containerName!, image: image!, volumeName: volumeName!, apiPort: apiPort!, uiPort: uiPort!, bindAddress, codexAuthDir,
            env: containerEnv,
            configDigest: "sha256:" + createHash("sha256").update(JSON.stringify(shape)).digest("hex"),
        },
    };
}

function selectedProviderConfiguration(extensionEnv: Record<string, string>): { provider: string; env: Record<string, string>; nativeEnv: Record<string, string>; codexAuthDir?: string } {
    const name = savedProviderSelection();
    if (name === undefined) {
        throw new Error("Hindsight: no saved provider selection; create providers/<name>.env and select it from /hindsight");
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
    if (!["openai", "anthropic", "deepseek", "opencode-go", "openai-responses", "openai-codex"].includes(provider)) {
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
    return { provider: name, env, nativeEnv, codexAuthDir };
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

export function providerNames(): string[] {
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

export function saveProviderSelection(name: string): void {
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

/** True when local launcher files predate management state. */
export function hasLegacyConfiguration(): boolean {
    if (fs.existsSync(HINDSIGHT_ENV_FILE) || fs.existsSync(SELECTION_FILE)) return true;
    try { return fs.readdirSync(PROVIDERS_DIR).some(entry => entry.endsWith(".env")); }
    catch { return false; }
}
