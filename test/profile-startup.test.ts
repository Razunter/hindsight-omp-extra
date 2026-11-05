import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, infrastructure, nativeEnv, profile, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

test("API and dashboard publishing defaults to IPv4 loopback", () => {
    const f = setup();
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.state().container!.portBindings).toEqual({
        "18888/tcp": [{ HostIp: "127.0.0.1", HostPort: "18888" }],
        "9999/tcp": [{ HostIp: "127.0.0.1", HostPort: "19999" }],
    });
});

test.each(["base", "profile", "process"])("bind address follows infrastructure precedence from %s", source => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_BIND_ADDRESS: "127.0.0.2" });
    if (source !== "base") f.envFile("providers/primary.env", { ...profile, HINDSIGHT_BIND_ADDRESS: "0.0.0.0" });
    const overrides = source === "process" ? { HINDSIGHT_BIND_ADDRESS: "::1" } : {};
    expect(f.run([{}], overrides).notifications.at(-1)?.level).toBe("info");
    const address = source === "base" ? "127.0.0.2" : source === "profile" ? "0.0.0.0" : "::1";
    expect(f.state().container!.portBindings).toEqual({
        "18888/tcp": [{ HostIp: address, HostPort: "18888" }],
        "9999/tcp": [{ HostIp: address, HostPort: "19999" }],
    });
});

test.each(["", "localhost", "127.0.0.1:8888", "300.0.0.1", "[::1]"])("invalid bind address %j leaves Docker untouched", address => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_BIND_ADDRESS: address });
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test.each(["18888/tcp", "9999/tcp"])("wider publishing on %s is corrected once without losing persistent data", port => {
    const f = setup();
    f.run();
    const legacy = f.state();
    legacy.container!.portBindings[port][0].HostIp = "";
    f.setState(legacy);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.state().container!.portBindings).toEqual({
        "18888/tcp": [{ HostIp: "127.0.0.1", HostPort: "18888" }],
        "9999/tcp": [{ HostIp: "127.0.0.1", HostPort: "19999" }],
    });
    expect(f.state().data).toBe("preserved-data");
    const runs = f.state().calls.filter(call => call[0] === "run").length;
    f.run();
    expect(f.state().calls.filter(call => call[0] === "run")).toHaveLength(runs);
});

test("changing and removing a bind override reconciles both published ports", () => {
    const f = setup();
    for (const address of ["127.0.0.1", "0.0.0.0", "127.0.0.1"]) {
        f.envFile(".env", address === "127.0.0.1" ? infrastructure : { ...infrastructure, HINDSIGHT_BIND_ADDRESS: address });
        expect(f.run().notifications.at(-1)?.level).toBe("info");
        expect(Object.values(f.state().container!.portBindings).map(bindings => bindings[0].HostIp)).toEqual([address, address]);
        expect(f.state().data).toBe("preserved-data");
    }
    expect(f.state().calls.filter(call => call[0] === "run")).toHaveLength(3);
});

test("legacy shared-memory limit is replaced without losing persistent data", () => {
    const f = setup();
    f.run();
    const legacy = f.state();
    legacy.container!.shmSize = 67108864;
    f.setState(legacy);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    const corrected = f.state();
    expect(corrected.container!.shmSize).toBe(1073741824);
    expect(corrected.data).toBe("preserved-data");
    const runCount = corrected.calls.filter(call => call[0] === "run").length;
    f.run();
    expect(f.state().calls.filter(call => call[0] === "run").length).toBe(runCount);
});

test("arbitrary base and profile variables reconcile additions, overrides and removals", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, OLLAMA_API_KEY: "synthetic-base-key", CUSTOM_EMPTY: "", CUSTOM_LITERAL: "a=b $HOME" });
    f.envFile("providers/primary.env", { ...profile, OLLAMA_API_KEY: "synthetic-selected-key", CUSTOM_PROFILE: "selected" });
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    const applied = nativeEnv(f.state());
    expect(applied.OLLAMA_API_KEY).toBe("synthetic-selected-key");
    expect(applied.CUSTOM_EMPTY).toBe("");
    expect(applied.CUSTOM_LITERAL).toBe("a=b $HOME");
    expect(applied.CUSTOM_PROFILE).toBe("selected");
    f.envFile("providers/primary.env", profile);
    f.run();
    expect(nativeEnv(f.state()).OLLAMA_API_KEY).toBe("synthetic-base-key");
    expect(nativeEnv(f.state()).CUSTOM_PROFILE).toBeUndefined();
    f.envFile(".env", infrastructure);
    f.run();
    expect(nativeEnv(f.state()).OLLAMA_API_KEY).toBeUndefined();
    expect(nativeEnv(f.state()).CUSTOM_EMPTY).toBeUndefined();
    expect(nativeEnv(f.state()).CUSTOM_LITERAL).toBeUndefined();
    expect(f.state().data).toBe("preserved-data");
});

test.each([{ HINDSIGHT_API_PORT: "0" }, { HINDSIGHT_API_PORT: "invalid" }, { HINDSIGHT_CP_PORT: "65536" }])("invalid container ports cannot be hidden by valid host overrides: %j", invalid => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...invalid });
    expect(f.run([{}], { HINDSIGHT_API_PORT: "18889", HINDSIGHT_UI_PORT: "19998" }).notifications.at(-1)?.level).toBe("error");
    expect(f.state().container).toBeNull();
    expect(f.state().calls).toEqual([]);
});

test("selected native settings cannot borrow legacy provider or credentials", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    const result = f.run([{}], { HINDSIGHT_API_LLM_MODEL: "legacy-model", HINDSIGHT_API_LLM_API_KEY: "legacy-key", HINDSIGHT_API_PORT: "18889" });
    expect(result.notifications.at(-1).level).toBe("info");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-profile-key");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(nativeEnv(f.state()).HINDSIGHT_OMP_API_PORT).toBe("18889");
});

test("base defaults and selected overrides combine, including unrelated native settings", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_REASONING_EFFORT: "low", HINDSIGHT_API_EMBEDDINGS_MODEL: "base-embeddings", HINDSIGHT_API_LOG_LEVEL: "warning" });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LOG_LEVEL: "debug", HINDSIGHT_API_PORT: "18890" });
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    const applied = nativeEnv(f.state());
    expect(applied.HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
    expect(applied.HINDSIGHT_API_LLM_MODEL).toBe("selected-model");
    expect(applied.HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-profile-key");
    expect(applied.HINDSIGHT_API_LLM_STRICT_SCHEMA).toBe("true");
    expect(applied.HINDSIGHT_API_LLM_MAX_CONCURRENT).toBe("3");
    expect(applied.HINDSIGHT_API_LLM_REASONING_EFFORT).toBe("low");
    expect(applied.HINDSIGHT_API_EMBEDDINGS_MODEL).toBe("base-embeddings");
    expect(applied.HINDSIGHT_API_LOG_LEVEL).toBe("debug");
    expect(applied.HINDSIGHT_OMP_API_PORT).toBe("18890");
    f.envFile(".env", { ...infrastructure, ...profile });
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.state()).HINDSIGHT_API_EMBEDDINGS_MODEL).toBeUndefined();
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_REASONING_EFFORT).toBeUndefined();
    expect(f.state().data).toBe("preserved-data");
});

test("switching providers retains common defaults but cannot inherit the old model or credentials", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":"synthetic-old-header"}' });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_STRICT_SCHEMA).toBe("true");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MAX_CONCURRENT).toBe("3");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_MODEL: "selected-model" });
    const before = f.state();
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_PROVIDER: "anthropic", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
});

test("changing service endpoint cannot send inherited credentials to the new service", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://old-service.invalid/v1", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"Authorization":"synthetic-old-header"}' });
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_BASE_URL: "https://new-service.invalid/v1", HINDSIGHT_API_LLM_MODEL: "selected-model" });
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
    f.envFile("providers/primary.env", { HINDSIGHT_API_LLM_BASE_URL: "https://new-service.invalid/v1", HINDSIGHT_API_LLM_MODEL: "selected-model", HINDSIGHT_API_LLM_API_KEY: "synthetic-new-key" });
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_API_KEY).toBe("synthetic-new-key");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_BASE_URL).toBe("https://new-service.invalid/v1");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
});

test("a selected-profile read failure cannot silently apply base-only configuration", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile });
    const result = f.run([{ failProfileRead: true }]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive");
    expect(f.state().calls).toEqual([]);
});

test.each(["../outside", "/tmp/outside", "missing", "", "bad/name"])("invalid selection %j leaves Docker untouched", name => {
    const f = setup(); f.select(name);
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    const result = f.run();
    expect(result.notifications.at(-1).level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("escaping profile symlinks fail without Docker work", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://legacy.invalid", OLLAMA_API_KEY: "synthetic-legacy-key" });
    fs.writeFileSync(path.join(f.root, "outside.env"), "HINDSIGHT_API_LLM_PROVIDER=openai");
    fs.symlinkSync("../outside.env", path.join(f.root, "providers/escape.env"));
    f.select("escape");
    expect(f.run().notifications.at(-1).level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("eligible startup makes one process-lifetime decision across reimports", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    const result = f.run([{ kind: "subagent" }, { hasUI: false }, {}, { selection: "other" }]);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(f.state().calls.filter((a: string[]) => a[0] === "version")).toHaveLength(1);
    f.run();
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MODEL).toBe("other-model");
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
    const result = f.run();
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive");
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(f.state().calls).toEqual([]);
});

test("removed managed fields recreate; image-only environment does not", () => {
    const f = setup();
    f.envFile("providers/primary.env", { ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://compatible.invalid/v1", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"X-Test":"old"}' });
    f.run();
    const old = f.state(); old.container!.env.push("IMAGE_ONLY=unrelated"); f.setState(old);
    f.run();
    expect(f.state().calls.filter(a => a[0] === "rm")).toEqual([]);
    f.envFile("providers/primary.env", profile); f.run();
    expect(f.state().calls.filter(a => a[0] === "rm")).toEqual([["rm", "-f", "fixture-hindsight"]]);
    const applied = nativeEnv(f.state());
    expect(applied.HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(applied.HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
    expect(f.state().container!.mounts).toEqual([{ Source: "fixture-data", Destination: "/home/hindsight/.pg0", RW: true }]);
    expect(f.state().data).toBe("preserved-data");
});

test("adding, changing and removing reasoning effort reconciles the container without deleting data", () => {
    const f = setup();
    f.run();
    for (const [index, effort] of ["low", "high", undefined].entries()) {
        f.envFile("providers/primary.env", effort === undefined ? profile : { ...profile, HINDSIGHT_API_LLM_REASONING_EFFORT: effort });
        expect(f.run().notifications.at(-1)?.level).toBe("info");
        expect(f.state().calls.filter(args => args[0] === "rm")).toHaveLength(index + 1);
        expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_REASONING_EFFORT).toBe(effort);
        expect(f.state().data).toBe("preserved-data");
    }
});

test("pull failure keeps existing policy and does not advance image stamp", () => {
    const f = setup(); const state = f.state(); state.pullFails = true; f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(fs.existsSync(path.join(f.root, ".last-image-check"))).toBe(false);
    state.pullFails = false; state.container = f.state().container; f.setState(state);
    f.run();
    const stamp = fs.readFileSync(path.join(f.root, ".last-image-check"), "utf8");
    f.run();
    expect(fs.readFileSync(path.join(f.root, ".last-image-check"), "utf8")).toBe(stamp);
    expect(f.state().calls.filter(a => a[0] === "pull")).toHaveLength(1);
});

test("missing selection is not retried on same-process reload", () => {
    const f = setup(); fs.unlinkSync(path.join(f.root, ".selected-provider"));
    const result = f.run([{}, { selection: "primary" }]);
    expect(result.notifications.map(n => n.level)).toEqual(["error"]);
    expect(f.state().calls).toEqual([]);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
});

test("subagents and noninteractive sessions do not resolve configuration or invoke Docker", () => {
    const f = setup(); fs.unlinkSync(path.join(f.root, ".selected-provider"));
    expect(f.run([{ kind: "subagent" }, { hasUI: false }]).notifications).toEqual([]);
    expect(f.state().calls).toEqual([]);
});

test("transport failure cannot echo profile credentials to logs or UI", () => {
    const f = setup(); const state = f.state(); state.runFails = true; f.setState(state);
    const result = f.run();
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(fs.readFileSync(path.join(f.root, "hindsight.log"), "utf8")).not.toContain("synthetic-profile-key");
});
