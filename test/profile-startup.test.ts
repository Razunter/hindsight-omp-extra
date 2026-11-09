import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, infrastructure, menu, nativeEnv, profile, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

test("API and dashboard publishing defaults to IPv4 loopback", () => {
    const f = setup();
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.container()!.portBindings).toEqual({
        "18888/tcp": [{ HostIp: "127.0.0.1", HostPort: "18888" }],
        "9999/tcp": [{ HostIp: "127.0.0.1", HostPort: "19999" }],
    });
    expect(f.container()!.shmSize).toBe(1073741824);
    expect(f.state().healthProbes).toEqual(["127.0.0.1:18888"]);
});

test.each(["base", "profile", "process"])("bind address follows infrastructure precedence from %s", source => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_BIND_ADDRESS: "127.0.0.2" });
    if (source !== "base") f.envFile("providers/primary.env", { ...profile, HINDSIGHT_BIND_ADDRESS: "0.0.0.0" });
    const overrides = source === "process" ? { HINDSIGHT_BIND_ADDRESS: "::1" } : {};
    expect(f.apply(overrides).notifications.at(-1)?.level).toBe("info");
    const address = source === "base" ? "127.0.0.2" : source === "profile" ? "0.0.0.0" : "::1";
    expect(f.container()!.portBindings).toEqual({
        "18888/tcp": [{ HostIp: address, HostPort: "18888" }],
        "9999/tcp": [{ HostIp: address, HostPort: "19999" }],
    });
});

test.each([["0.0.0.0", "127.0.0.1:18888"], ["::", "[::1]:18888"]])("readiness for wildcard bind %s probes loopback", (address, probe) => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_BIND_ADDRESS: address });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.state().healthProbes).toEqual([probe]);
});

test.each(["", "localhost", "127.0.0.1:8888", "300.0.0.1", "[::1]"])("invalid bind address %j leaves Docker untouched", address => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_BIND_ADDRESS: address });
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("changing and removing a bind override is applied through approval on the same volume", () => {
    const f = setup();
    for (const address of ["127.0.0.1", "0.0.0.0", "127.0.0.1"]) {
        f.envFile(".env", address === "127.0.0.1" ? infrastructure : { ...infrastructure, HINDSIGHT_BIND_ADDRESS: address });
        expect(f.apply().notifications.at(-1)?.level).toBe("info");
        expect(Object.values(f.container()!.portBindings).map(bindings => bindings[0].HostIp)).toEqual([address, address]);
        expect(f.state().data).toBe("preserved-data");
    }
    expect(f.state().calls.filter(call => call[0] === "run")).toHaveLength(3);
    expect(f.state().sharedVolumeRun).toBeUndefined();
});

test("arbitrary base and profile variables apply additions, overrides and removals", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, OLLAMA_API_KEY: "synthetic-base-key", CUSTOM_EMPTY: "", CUSTOM_LITERAL: "a=b $HOME" });
    f.envFile("providers/primary.env", { ...profile, OLLAMA_API_KEY: "synthetic-selected-key", CUSTOM_PROFILE: "selected" });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    const applied = nativeEnv(f.container());
    expect(applied.OLLAMA_API_KEY).toBe("synthetic-selected-key");
    expect(applied.CUSTOM_EMPTY).toBe("");
    expect(applied.CUSTOM_LITERAL).toBe("a=b $HOME");
    expect(applied.CUSTOM_PROFILE).toBe("selected");
    f.envFile("providers/primary.env", profile);
    f.apply();
    expect(nativeEnv(f.container()).OLLAMA_API_KEY).toBe("synthetic-base-key");
    expect(nativeEnv(f.container()).CUSTOM_PROFILE).toBeUndefined();
    f.envFile(".env", infrastructure);
    f.apply();
    expect(nativeEnv(f.container()).OLLAMA_API_KEY).toBeUndefined();
    expect(nativeEnv(f.container()).CUSTOM_EMPTY).toBeUndefined();
    expect(nativeEnv(f.container()).CUSTOM_LITERAL).toBeUndefined();
    expect(f.state().data).toBe("preserved-data");
});

test.each([{ HINDSIGHT_API_PORT: "0" }, { HINDSIGHT_API_PORT: "invalid" }, { HINDSIGHT_CP_PORT: "65536" }])("invalid container ports cannot be hidden by valid host overrides: %j", invalid => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...invalid });
    expect(f.apply({ HINDSIGHT_API_PORT: "18889", HINDSIGHT_UI_PORT: "19998" }).notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("selected native settings cannot borrow legacy provider or credentials", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    const result = f.apply({ HINDSIGHT_API_LLM_MODEL: "legacy-model", HINDSIGHT_API_LLM_API_KEY: "legacy-key", HINDSIGHT_API_PORT: "18889" });
    expect(result.notifications.at(-1)?.level).toBe("info");
    const applied = nativeEnv(f.container());
    expect(applied.HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
    expect(applied.HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(applied.HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-profile-key");
    expect(applied.HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(f.container()!.portBindings["18888/tcp"][0].HostPort).toBe("18889");
});

test("base defaults and selected overrides combine, including unrelated native settings", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_REASONING_EFFORT: "low", HINDSIGHT_API_EMBEDDINGS_MODEL: "base-embeddings", HINDSIGHT_API_LOG_LEVEL: "warning" });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LOG_LEVEL: "debug", HINDSIGHT_API_PORT: "18890" });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    const applied = nativeEnv(f.container());
    expect(applied.HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
    expect(applied.HINDSIGHT_API_LLM_MODEL).toBe("selected-model");
    expect(applied.HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-profile-key");
    expect(applied.HINDSIGHT_API_LLM_STRICT_SCHEMA).toBe("true");
    expect(applied.HINDSIGHT_API_LLM_MAX_CONCURRENT).toBe("3");
    expect(applied.HINDSIGHT_API_LLM_REASONING_EFFORT).toBe("low");
    expect(applied.HINDSIGHT_API_EMBEDDINGS_MODEL).toBe("base-embeddings");
    expect(applied.HINDSIGHT_API_LOG_LEVEL).toBe("debug");
    expect(f.container()!.portBindings["18890/tcp"][0].HostPort).toBe("18890");
    f.envFile(".env", { ...infrastructure, ...profile });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_EMBEDDINGS_MODEL).toBeUndefined();
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_REASONING_EFFORT).toBeUndefined();
    expect(f.state().data).toBe("preserved-data");
});

test("switching providers retains common defaults but cannot inherit the old model or credentials", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":"synthetic-old-header"}' });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_STRICT_SCHEMA).toBe("true");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MAX_CONCURRENT).toBe("3");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_MODEL: "selected-model" });
    const before = f.state();
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
});

test("changing service endpoint cannot send inherited credentials to the new service", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://old-service.invalid/v1", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":"synthetic-old-header"}' });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_BASE_URL: "https://new-service.invalid/v1", HINDSIGHT_API_LLM_MODEL: "selected-model" });
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_BASE_URL: "https://new-service.invalid/v1", HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-new-key");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_BASE_URL).toBe("https://new-service.invalid/v1");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
});

test("a selected-profile read failure cannot silently apply base-only configuration", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile });
    f.apply();
    f.envFile("providers/primary.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "changed-model" });
    const before = f.state().calls.length;
    const result = f.run([{ failProfileRead: true }]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive");
    expect(f.state().calls).toHaveLength(before);
});

test.each(["../outside", "/tmp/outside", "missing", "", "bad/name"])("invalid selection %j leaves Docker untouched", name => {
    const f = setup(); f.select(name);
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("escaping profile symlinks fail without Docker work", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    fs.writeFileSync(path.join(f.root, "outside.env"), "HINDSIGHT_API_LLM_PROVIDER=openai");
    fs.symlinkSync("../outside.env", path.join(f.root, "providers/escape.env"));
    f.select("escape");
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test.each([
    { HINDSIGHT_API_LLM_API_KEY: "" },
    { HINDSIGHT_API_LLM_PROVIDER: "unknown" },
    { HINDSIGHT_API_LLM_STRICT_SCHEMA: "yes" },
    { HINDSIGHT_API_LLM_MAX_CONCURRENT: "0" },
    { HINDSIGHT_API_LLM_BASE_URL: "synthetic-sensitive-invalid-url" },
    { HINDSIGHT_API_LLM_DEFAULT_HEADERS: "synthetic-sensitive-invalid-headers" },
    { HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":42}' },
    { HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"X-Test":"bad\\nheader"}' },
    { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_BASE_URL: "https://opencode.ai/zen/go/v1" },
    { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_BASE_URL: "https://opencode.ai/zen/go" },
    { HINDSIGHT_API_LLM_PROVIDER: "opencode-go", HINDSIGHT_API_LLM_MODEL: "opencode-go/deepseek-v4-flash", HINDSIGHT_API_LLM_BASE_URL: "https://opencode.ai/zen/go/v1" },
])("invalid native settings fail locally without secret disclosure: %j", invalid => {
    const f = setup(); f.envFile("providers/primary.env", { ...profile, ...invalid });
    const result = f.apply();
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive");
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(f.state().calls).toEqual([]);
});

test("adding, changing and removing reasoning effort is applied without deleting data", () => {
    const f = setup();
    f.apply();
    for (const effort of ["low", "high", undefined]) {
        f.envFile("providers/primary.env", effort === undefined ? profile : { ...profile, HINDSIGHT_API_LLM_REASONING_EFFORT: effort });
        expect(f.apply().notifications.at(-1)?.level).toBe("info");
        expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_REASONING_EFFORT).toBe(effort);
        expect(f.state().data).toBe("preserved-data");
    }
    expect(f.state().calls.filter(call => call[0] === "run")).toHaveLength(4);
});

test("missing selection at startup is reported once and not retried on same-process reload", () => {
    const f = setup(); f.apply();
    const state = f.state(); state.containers["fixture-hindsight"].running = false; f.setState(state);
    fs.unlinkSync(path.join(f.root, ".selected-provider"));
    const before = f.state().calls.length;
    const result = f.run([{}, { selection: "primary" }]);
    expect(result.notifications.map(n => n.level)).toEqual(["error"]);
    expect(f.state().calls).toHaveLength(before);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.container()!.running).toBe(true);
});

test.each(["\n", "\r"])("line break %j cannot inject container variables or replace the existing container", separator => {
    const f = setup();
    f.apply();
    const before = f.state();
    expect(f.apply({ HINDSIGHT_WORKER_ID: "worker" + separator + "INJECTED=unexpected" }).notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
});

test.each(["create", "replace"])("Docker %s receives credentials without exposing them in arguments", operation => {
    const f = setup();
    if (operation === "replace") f.apply();
    const secrets = {
        HINDSIGHT_API_LLM_API_KEY: "synthetic-key=with spaces $HOME",
        HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":"Bearer synthetic-header"}',
        HTTPS_PROXY: "http://synthetic-user:synthetic-password@proxy.invalid:8080",
    };
    const containerControls = { PATH: "/container-only/bin", DOCKER_HOST: "unix:///container.sock", DOCKER_CONTEXT: "container-context", DOCKER_CONFIG: "/container/.docker" };
    const hostControls = { DOCKER_HOST: "unix:///host.sock", DOCKER_CONTEXT: "host-context", DOCKER_CONFIG: "/host/.docker" };
    f.envFile("providers/primary.env", { ...profile, ...secrets, ...containerControls, CUSTOM_EMPTY: "", CUSTOM_LITERAL: "a=b $HOME" });
    const result = f.apply({ ...hostControls, HINDSIGHT_API_LLM_API_KEY: "synthetic-ambient-key", UNRELATED_HOST_SECRET: "synthetic-unrelated-secret" });
    expect(result.notifications.at(-1)?.level).toBe("info");
    const state = f.state();
    const applied = nativeEnv(f.container());
    for (const [key, value] of Object.entries(secrets)) expect(applied[key]).toBe(value);
    for (const [key, value] of Object.entries(containerControls)) expect(applied[key]).toBe(value);
    expect(state.runEnvironment).toEqual({ ...hostControls, PATH: path.join(f.root, "bin") + ":" + process.env.PATH });
    expect(state.envFile?.mode).toBe(0o600);
    expect(fs.existsSync(path.dirname(state.envFile!.path))).toBe(false);
    expect(applied.CUSTOM_EMPTY).toBe("");
    expect(applied.CUSTOM_LITERAL).toBe("a=b $HOME");
    expect(applied.UNRELATED_HOST_SECRET).toBeUndefined();
    const visible = JSON.stringify([state.calls, result, f.management()]);
    for (const value of Object.values(secrets)) expect(visible).not.toContain(value);
});

test("transport failure cannot echo profile credentials to logs, UI or management state", () => {
    const f = setup(); const state = f.state(); state.runFails = true; f.setState(state);
    const result = f.apply();
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(JSON.stringify(f.management())).not.toContain("synthetic-profile-key");
    expect(fs.readFileSync(path.join(f.root, "hindsight.log"), "utf8")).not.toContain("synthetic-profile-key");
    expect(fs.existsSync(path.dirname(f.state().envFile!.path))).toBe(false);
});

test("the menu Apply action in Off mode does no Docker work", () => {
    const f = setup();
    const result = f.run([{ startup: false, command: true, choices: [menu.apply], confirm: true }]);
    expect(result.notifications.at(-1)?.level).toBe("warning");
    expect(f.state().calls).toEqual([]);
});
