import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, nativeEnv, profile, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

function authorizeFixture(f: Fixture, name = "codex-auth") {
    const directory = path.join(f.root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "fixture-account" } }));
    return directory;
}
function codexProfile(directory: string) {
    const { HINDSIGHT_API_LLM_API_KEY, ...settings } = profile;
    return { ...settings, HINDSIGHT_API_LLM_PROVIDER: "openai-codex", HINDSIGHT_OMP_CODEX_AUTH_DIR: directory };
}

test("native Codex uses a persistent writable directory without a static key", () => {
    const f = setup(); const directory = authorizeFixture(f);
    f.envFile("providers/primary.env", codexProfile(directory));
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    const env = nativeEnv(f.container());
    expect(env.HINDSIGHT_API_LLM_CODEX_HOME).toBe("/home/hindsight/.codex");
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBeUndefined();
    expect(f.container()!.mounts).toEqual([
        { Source: "fixture-data", Destination: "/home/hindsight/.pg0", RW: true },
        { Source: directory, Destination: "/home/hindsight/.codex", RW: true },
    ]);
});

test("both native transitions and host-directory change replace the runtime without deleting data or auth", () => {
    const f = setup(); const first = authorizeFixture(f); const second = authorizeFixture(f, "codex-other");
    const initialAuth = fs.readFileSync(path.join(first, "auth.json"), "utf8");
    f.envFile("providers/primary.env", { ...profile, HINDSIGHT_API_LLM_BASE_URL: "https://key.invalid/v1", HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"X-Test":"old"}' });
    f.apply();
    f.envFile("providers/primary.env", codexProfile(first));
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_API_KEY).toBeUndefined();
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_DEFAULT_HEADERS).toBeUndefined();
    f.envFile("providers/primary.env", codexProfile(second)); f.apply();
    expect(f.container()!.mounts.find(m => m.Destination === "/home/hindsight/.codex")?.Source).toBe(second);
    f.envFile("providers/primary.env", profile); f.apply();
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_CODEX_HOME).toBeUndefined();
    expect(f.container()!.mounts).toEqual([{ Source: "fixture-data", Destination: "/home/hindsight/.pg0", RW: true }]);
    expect(f.state().calls.filter(a => a[0] === "run")).toHaveLength(4);
    expect(f.state().data).toBe("preserved-data");
    expect(fs.readFileSync(path.join(first, "auth.json"), "utf8")).toBe(initialAuth);
    expect(fs.readFileSync(path.join(second, "auth.json"), "utf8")).toBe(initialAuth);
});

test.each(["", "relative/path", "/nonexistent-fixture-codex-directory"])("invalid auth directory %j leaves the running container intact", directory => {
    const f = setup(); f.apply(); const before = f.state();
    f.envFile("providers/primary.env", codexProfile(directory));
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state()).toEqual(before);
});

test.each(["missing", "malformed", "no-access", "no-refresh", "not-directory", "read-only"])("unusable local Codex auth: %s", failure => {
    const f = setup(); f.apply(); const before = f.state(); const directory = authorizeFixture(f);
    const auth = path.join(directory, "auth.json");
    if (failure === "missing") fs.unlinkSync(auth);
    if (failure === "malformed") fs.writeFileSync(auth, "synthetic-sensitive-malformed-json");
    if (failure === "no-access") fs.writeFileSync(auth, JSON.stringify({ tokens: { refresh_token: "synthetic-refresh" } }));
    if (failure === "no-refresh") fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: "synthetic-access" } }));
    if (failure === "read-only") fs.chmodSync(directory, 0o500);
    f.envFile("providers/primary.env", codexProfile(failure === "not-directory" ? auth : directory));
    const result = f.apply();
    if (failure === "read-only") fs.chmodSync(directory, 0o700);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive");
    expect(JSON.stringify(result)).not.toContain("synthetic-access");
    expect(f.state()).toEqual(before);
});

test("retargeted credential symlinks are pending until applied, then use the canonical host directory", () => {
    const f = setup(); const first = authorizeFixture(f); const second = authorizeFixture(f, "codex-other");
    const alias = path.join(f.root, "codex-link");
    fs.symlinkSync(first, alias);
    f.envFile("providers/primary.env", codexProfile(alias)); f.apply();
    fs.unlinkSync(alias); fs.symlinkSync(second, alias);
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(f.container()!.mounts[1].Source).toBe(first);
    f.apply();
    expect(nativeEnv(f.container()).HINDSIGHT_OMP_CODEX_AUTH_DIR).toBe(second);
    expect(f.container()!.mounts[1].Source).toBe(second);
    expect(f.state().data).toBe("preserved-data");
});

test("a symlinked OMP storage root cannot be mounted as a credential directory", () => {
    const f = setup(); const directory = authorizeFixture(f);
    fs.mkdirSync(path.join(f.root, ".omp"));
    fs.symlinkSync(directory, path.join(f.root, ".omp/agent"));
    f.envFile("providers/primary.env", codexProfile(directory));
    expect(f.apply({ HOME: f.root }).notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test.each(["direct", "symlink", "parent"])("relocated OMP storage cannot be exposed through a Codex mount: %s", mode => {
    const f = setup(); const directory = authorizeFixture(f);
    let agentRoot = directory;
    if (mode === "symlink") {
        agentRoot = path.join(f.root, "custom-agent");
        fs.symlinkSync(directory, agentRoot);
    }
    if (mode === "parent") {
        agentRoot = path.join(directory, "custom-agent");
        fs.mkdirSync(agentRoot);
    }
    f.envFile("providers/primary.env", codexProfile(directory));
    expect(f.apply({ PI_CODING_AGENT_DIR: agentRoot }).notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});
