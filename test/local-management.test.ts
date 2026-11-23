import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixture, imageId, infrastructure, menu, nativeEnv, profile, type Container, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const newId = "sha256:" + "2".repeat(64);
const shortId = imageId.slice(7, 19);
const deadPid = Bun.spawnSync(["true"]).pid;
const mutating = (f: Fixture) => f.state().calls.filter(call => ["run", "start", "stop", "rename", "rm", "pull", "build", "volume"].includes(call[0]));

function legacyContainer(f: Fixture, running = true): Container {
    const state = f.state();
    const container: Container = {
        id: "legacy".padEnd(64, "0"), image: imageId, running, env: ["HINDSIGHT_API_LLM_MODEL=legacy-model"], labels: {},
        mounts: [{ Source: "fixture-data", Destination: "/home/hindsight/.pg0", RW: true }],
        shmSize: 1073741824, portBindings: { "18888/tcp": [{ HostIp: "127.0.0.1", HostPort: "18888" }] },
    };
    state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME] = container;
    f.setState(state);
    return container;
}
function status(f: Fixture, overrides?: Record<string, string>): string {
    return f.run([{ startup: false, command: true, choices: [menu.status] }], overrides).notifications.at(-1)!.message;
}
function localFiles(f: Fixture) {
    return [".env", ".selected-provider", "providers/primary.env"].map(file => fs.readFileSync(path.join(f.root, file), "utf8"));
}

test("a fresh installation without Docker or local files keeps evidence and does no lifecycle work", () => {
    const f = setup();
    for (const file of [".env", ".selected-provider", "providers/primary.env"]) fs.unlinkSync(path.join(f.root, file));
    const result = f.run([{}, { startup: false, command: true, choices: [menu.status] }]);
    expect(result.tools).toContain("hindsight_evidence");
    expect(new Set(result.commands)).toEqual(new Set(["hindsight"]));
    expect(result.notifications.map(n => n.level)).toEqual(["info"]);
    expect(f.management()).toBeUndefined();
    expect(f.state().calls).toEqual([]);
});

test("legacy configuration gets one nonmodal migration notice across processes and is left untouched", () => {
    const f = setup(); const container = legacyContainer(f);
    const files = localFiles(f);
    const first = f.run();
    expect(first.notifications.map(n => n.level)).toEqual(["info"]);
    expect(first.dialogs).toEqual([]);
    expect(f.run().notifications).toEqual([]);
    expect(f.management()).toMatchObject({ mode: "off", noticeShown: true });
    expect(f.management()!.active).toBeUndefined();
    expect(localFiles(f)).toEqual(files);
    expect(f.container()).toEqual(container);
    expect(f.state().calls).toEqual([]);
    expect(f.state().data).toBe("preserved-data");
});

test("incomplete or invalid local files cause no launcher errors while management is Off", () => {
    const f = setup();
    f.envFile(".env", { HINDSIGHT_BIND_ADDRESS: "not-an-address" });
    f.select("../outside");
    fs.unlinkSync(path.join(f.root, "providers/primary.env"));
    const result = f.run([{}, { startup: false, command: true, choices: [menu.status] }]);
    expect(result.notifications.map(n => n.level)).toEqual(["info", "info"]);
    expect(f.state().calls).toEqual([]);
});

test("menu access and cancellation work without valid local setup", () => {
    const f = setup();
    for (const file of [".env", ".selected-provider", "providers/primary.env"]) fs.unlinkSync(path.join(f.root, file));
    const result = f.run([
        { startup: false, command: true, choices: [] },
        { startup: false, command: true, choices: [menu.mode] },
        { startup: false, command: true, choices: [menu.status] },
    ]);
    expect(result.notifications.map(n => n.level)).toEqual(["info"]);
    expect(f.management()).toBeUndefined();
    expect(f.state().calls).toEqual([]);
});

test("Status shows last known mental model details with local management Off", () => {
    const f = setup();
    const dir = path.join(f.root, "hindsight-mental-model-monitor");
    fs.mkdirSync(dir);
    const checkedAt = Date.UTC(2026, 10, 21, 15);
    for (const [id, check] of [
        ["user-preferences", { checkedAt, model: { name: "User Preferences", status: "Paused", refreshedAt: null }, failed: true }],
        ["project-decisions", { checkedAt, model: { name: "Project Decisions", status: "Unknown" } }],
    ] as const) {
        const key = createHash("sha256").update(JSON.stringify(["http://status-fixture.invalid", "fixture-bank", id])).digest("hex");
        fs.writeFileSync(path.join(dir, key + ".json"), JSON.stringify(check));
    }
    const result = f.run([{ startup: false, mentalModels: true, command: true, choices: [menu.status] }]);
    const detail = result.notifications[0]!.message;
    expect(detail).toContain("Management is Off: Docker was not inspected");
    expect(detail).toContain("Check unavailable · last known: 2 models · 1 paused · 1 unknown");
    expect(detail).toContain("User Preferences: Paused · never refreshed · checked");
    expect(detail).toContain("Project Decisions: Unknown · refresh time unknown · checked");
    expect(f.state().calls).toEqual([]);
});

test("choosing CPU applies the identified cached runtime in-process after one approval", () => {
    const f = setup();
    expect(status(f)).not.toContain(shortId);
    const result = f.run([{ startup: false, command: true, choices: [menu.mode, "CPU"], confirm: true }]);
    expect(result.dialogs.filter(dialog => dialog.message !== undefined)).toHaveLength(1);
    expect(result.dialogs.at(-1)!.message).toContain(shortId);
    expect(result.notifications.at(-1)?.level).toBe("info");
    const container = f.container()!;
    expect(container).toMatchObject({ image: imageId, running: true, labels: { "io.github.razunter.hindsight-omp.installation": f.management()!.installationId } });
    expect(f.management()).toMatchObject({ mode: "cpu", active: { mode: "cpu", provider: "primary", imageId, upstream: { reference: infrastructure.HINDSIGHT_IMAGE, digests: ["sha256:" + "a".repeat(64)] } } });
    expect(f.management()!.operation).toBeUndefined();
    expect(f.state().calls.filter(call => ["pull", "build"].includes(call[0]))).toEqual([]);
    expect(status(f)).toContain(shortId);
});

test("declining approval prepares and replaces nothing and keeps the request visibly pending", () => {
    const f = setup(); const container = legacyContainer(f);
    f.run([{ startup: false, command: true, choices: [menu.mode, "CPU"], confirm: false }]);
    expect(mutating(f)).toEqual([]);
    expect(f.container()).toEqual(container);
    expect(f.management()).toMatchObject({ mode: "cpu" });
    expect(f.management()!.active).toBeUndefined();
    expect(status(f)).not.toContain(shortId);
    const startup = f.run();
    expect(startup.notifications.map(n => n.level)).toEqual(["warning"]);
    expect(mutating(f)).toEqual([]);
});

test("adopting a legacy container stops it gracefully before reusing its volume", () => {
    const f = setup(); legacyContainer(f);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    const calls = mutating(f).map(call => call.slice(0, 3).join(" "));
    expect(calls[0]).toBe("stop --time 75");
    expect(calls[1]).toStartWith("rename fixture-hindsight fixture-hindsight-previous-");
    expect(calls[2]).toStartWith("run -d --pull");
    expect(f.state().sharedVolumeRun).toBeUndefined();
    expect(Object.keys(f.state().containers)).toEqual(["fixture-hindsight"]);
    expect(f.container()!.mounts).toEqual([{ Source: "fixture-data", Destination: "/home/hindsight/.pg0", RW: true }]);
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(f.state().data).toBe("preserved-data");
});

test("applying an unchanged active runtime asks nothing and restarts nothing", () => {
    const f = setup(); f.apply();
    const before = mutating(f).length;
    const result = f.apply();
    expect(result.dialogs.filter(dialog => dialog.message !== undefined)).toEqual([]);
    expect(result.notifications.at(-1)).toEqual({ level: "info", message: "Hindsight: Nothing to apply." });
    expect(mutating(f)).toHaveLength(before);
});

function codexFixture(): Fixture {
    const f = setup();
    const auth = path.join(f.root, "codex");
    fs.mkdirSync(auth);
    fs.writeFileSync(path.join(auth, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } }));
    f.envFile("providers/primary.env", { ...profile, HINDSIGHT_API_LLM_PROVIDER: "openai-codex", HINDSIGHT_OMP_CODEX_AUTH_DIR: auth });
    return f;
}

test("Apply repairs a stale Codex bind mount only after approval, using the same image and data", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].codexAuthExit = 42;
    f.setState(state);
    const before = mutating(f).length;
    const declined = f.run([{ startup: false, command: true, choices: [menu.apply], confirm: false }]);
    expect(declined.dialogs.at(-1)?.message).toEqual(expect.stringContaining("auth.json is not readable"));
    expect(mutating(f)).toHaveLength(before);
    expect(status(f)).toContain("auth.json is not readable");
    expect(f.run().notifications.some(n => n.level === "warning" && n.message.includes("auth.json is not readable"))).toBe(true);
    expect(mutating(f)).toHaveLength(before);

    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.container()!.id).not.toBe(state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].id);
    expect(f.state().data).toBe("preserved-data");
    expect(status(f)).not.toContain("auth.json is not readable");
    expect(f.apply().dialogs.filter(dialog => dialog.message !== undefined)).toEqual([]);
});

test.each([
    ["API key", "HINDSIGHT_API_LLM_API_KEY"],
    ["auth headers", "HINDSIGHT_API_LLM_DEFAULT_HEADERS"],
    ["Codex host path metadata", "HINDSIGHT_OMP_CODEX_AUTH_DIR"],
])("Startup and Status report drift in %s and Apply repairs it without exposing values", (_label, key) => {
    const f = key === "HINDSIGHT_OMP_CODEX_AUTH_DIR" ? codexFixture() : setup();
    if (key === "HINDSIGHT_API_LLM_DEFAULT_HEADERS") {
        f.envFile("providers/primary.env", { ...profile, [key]: '{"Authorization":"synthetic-expected=header"}' });
    }
    f.apply();
    const state = f.state();
    const container = state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME];
    const expected = nativeEnv(container)[key];
    expect(expected).toBeDefined();
    const wrong = "synthetic-wrong=value";
    container.env = container.env.map(entry => entry.startsWith(`${key}=`) ? `${key}=${wrong}` : entry);
    f.setState(state);
    const before = mutating(f).length;
    const startup = f.run().notifications.at(-1);
    const declined = f.run([{ startup: false, command: true, choices: [menu.apply], confirm: false }]);
    expect(startup?.level).toBe("warning");
    for (const message of [startup!.message, status(f), declined.dialogs.at(-1)?.message ?? ""]) {
        expect(message).toContain(key);
        expect(message).not.toContain(wrong);
        expect(message).not.toContain(expected);
    }
    expect(mutating(f)).toHaveLength(before);

    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container())[key]).toBe(expected);
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.container()!.id).not.toBe(container.id);
    expect(f.state().data).toBe("preserved-data");
    expect(mutating(f).slice(before).filter(([verb]) => verb === "pull" || verb === "build")).toEqual([]);
    expect(status(f)).not.toContain(key);
});

test("Apply repairs drift using the approved CPU image ID when its registry reference is gone", () => {
    const f = setup();
    f.apply();
    const state = f.state();
    state.images[imageId].digests = [];
    const container = state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME];
    container.env = container.env.filter(entry => !entry.startsWith("HINDSIGHT_API_LLM_API_KEY="));
    f.setState(state);
    const before = mutating(f).length;
    const result = f.apply();
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(result.notifications.at(-1)?.message).not.toContain("matches the selected configuration");
    expect(mutating(f).slice(before).some(([verb]) => verb === "pull")).toBe(false);
    expect(f.container()?.image).toBe(imageId);
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_API_KEY).toBe(profile.HINDSIGHT_API_LLM_API_KEY);
});

test("a readable Codex file on a read-only bind does not verify the selection", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].mounts.find(mount => mount.Destination === "/home/hindsight/.codex")!.RW = false;
    f.setState(state);
    const before = f.state().calls.length;
    expect(status(f)).toContain("credential bind mount");
    expect(f.state().calls.slice(before).some(([verb]) => verb === "exec")).toBe(false);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.container()?.mounts.find(mount => mount.Destination === "/home/hindsight/.codex")?.RW).toBe(true);
});

test("Startup and Status accept a readable credential bind with a rewritten Docker source", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    const container = state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME];
    const mount = container.mounts.find(mount => mount.Destination === "/home/hindsight/.codex")!;
    mount.Source = "/daemon/rewritten-credential-source";
    container.codexAuthExit = 0;
    f.setState(state);

    const before = mutating(f).length;
    const startup = f.run([{}], { WSL_DISTRO_NAME: "" });
    expect(startup.notifications.filter(n => n.level === "warning")).toEqual([]);
    expect(startup.notifications.at(-1)?.message).not.toContain("matches the selected configuration");
    const report = status(f, { WSL_DISTRO_NAME: "" });
    expect(report).not.toContain("matches the selected configuration");
    expect(report).not.toMatch(/credential (bind mount|file)/);
    expect(mutating(f)).toHaveLength(before);
});

test("a pending provider selection does not probe the previously applied Codex mount", () => {
    const f = codexFixture();
    f.apply();
    f.envFile("providers/next.env", profile);
    f.select("next");
    const before = f.state().calls.length;
    expect(f.run().notifications.at(-1)?.message).toContain("was not applied");
    expect(status(f)).toContain("has not been applied. Choose Apply requested configuration");
    expect(f.state().calls.slice(before).some(([verb]) => verb === "exec")).toBe(false);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
});

test("a failed container inspection is inconclusive and does not offer replacement", () => {
    const f = setup();
    f.apply();
    f.setState({ ...f.state(), containerInspectFails: true });
    const before = mutating(f).length;
    expect(status(f)).toContain("could not verify");
    const result = f.apply();
    expect(result.notifications.at(-1)).toMatchObject({ level: "warning", message: expect.stringContaining("could not verify") });
    expect(result.dialogs.every(dialog => dialog.message === undefined)).toBe(true);
    expect(mutating(f)).toHaveLength(before);
});

test("Status reports a different running configuration without probing its credentials", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].labels["io.github.razunter.hindsight-omp.config"] = "different";
    f.setState(state);
    const before = f.state().calls.length;
    expect(status(f)).toContain("not applied to the running container. Choose Apply requested configuration");
    expect(f.state().calls.slice(before).some(([verb]) => verb === "exec")).toBe(false);
});

test("missing credential mount metadata is inconclusive and does not offer replacement", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    const mount = state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].mounts.find(mount => mount.Destination === "/home/hindsight/.codex");
    Reflect.deleteProperty(mount!, "RW");
    f.setState(state);
    const before = mutating(f).length;
    expect(status(f)).toContain("could not verify the credential bind mount");
    const result = f.apply();
    expect(result.notifications.at(-1)?.message).toContain("could not verify the credential bind mount");
    expect(result.dialogs.every(dialog => dialog.message === undefined)).toBe(true);
    expect(mutating(f)).toHaveLength(before);
});

test("an unavailable Codex mount probe does not claim the runtime matches or replace it", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME].codexAuthExit = 125;
    f.setState(state);
    const before = mutating(f).length;
    const result = f.apply();
    expect(result.notifications.at(-1)).toMatchObject({ level: "warning", message: expect.stringContaining("could not check whether the credential file auth.json is readable") });
    expect(mutating(f)).toHaveLength(before);
});

test("mount repair approval cannot replace a new container that took the same name", () => {
    const f = codexFixture();
    f.apply();
    const name = infrastructure.HINDSIGHT_CONTAINER_NAME;
    const state = f.state();
    const replacement = { ...state.containers[name], id: "d".repeat(64) };
    state.containers[name].codexAuthExit = 42;
    f.setState(state);
    const before = mutating(f).length;
    const result = f.run([{ startup: false, command: true, choices: [menu.apply], confirm: true, afterConfirmContainer: { [name]: replacement } }]);
    expect(result.notifications.at(-1)).toMatchObject({ level: "warning", message: expect.stringContaining("the container changed") });
    expect(f.container()?.id).toBe(replacement.id);
    expect(mutating(f)).toHaveLength(before);
});

test("mount repair rollback preserves a stopped container that arrived during cutover", () => {
    const f = codexFixture();
    f.apply();
    const name = infrastructure.HINDSIGHT_CONTAINER_NAME;
    const state = f.state();
    const original = state.containers[name];
    original.codexAuthExit = 42;
    const occupant = { ...original, id: "d".repeat(64), running: false, labels: {} };
    f.setState({ ...state, runConflict: occupant });
    const result = f.apply();
    expect(f.container()).toEqual(occupant);
    const previous = `${name}-previous-${original.id.slice(0, 12)}`;
    expect(f.container(previous)).toEqual({ ...original, running: false });
    expect(result.notifications.at(-1)).toMatchObject({ level: "error", message: expect.stringContaining(previous) });
});

test("after an approved cutover an unreadable Codex mount is reported without another restart", () => {
    const f = codexFixture();
    f.setState({ ...f.state(), codexAuthExitOnRun: 42 });
    const result = f.apply();
    expect(result.notifications.at(-1)).toMatchObject({ level: "warning", message: expect.stringContaining("auth.json is not readable") });
    expect(f.container()?.running).toBe(true);
    expect(mutating(f).map(call => call[0])).toEqual(["run"]);
});

test("cutover does not verify a different container that took the name after launch", () => {
    const f = codexFixture();
    f.apply();
    const state = f.state();
    const name = infrastructure.HINDSIGHT_CONTAINER_NAME;
    state.containers[name].codexAuthExit = 42;
    state.mutate = { when: `rm ${name}-previous-`, replaceContainer: { name, id: "d".repeat(64) } };
    f.setState(state);
    const before = state.calls.length;
    const result = f.apply();
    expect(result.notifications.at(-1)?.message).toContain("could not verify the selected configuration");
    expect(f.container()?.id).toBe("d".repeat(64));
    expect(f.state().calls.slice(before).some(call => call[0] === "exec" && call[1] === "d".repeat(64))).toBe(false);
});

test("Off stops future management immediately without stopping or deleting the service", () => {
    const f = setup(); f.apply();
    const running = f.container(); const before = f.state().calls.length;
    const result = f.run([{ startup: false, command: true, choices: [menu.mode, "Off"] }]);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.state().calls).toHaveLength(before);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ mode: "off", active: { imageId } });
    const stopped = f.state(); stopped.containers["fixture-hindsight"].running = false; f.setState(stopped);
    expect(f.run().notifications).toEqual([]);
    expect(f.state().calls).toHaveLength(before);
    expect(status(f)).toContain(shortId);
});

test("Off after approval wins before cutover and records the abandoned change separately", () => {
    const f = setup(); const container = legacyContainer(f); f.manage({ mode: "cpu" });
    const result = f.run([{ startup: false, command: true, choices: [menu.apply], confirm: true, afterConfirm: { mode: "off" } }]);
    expect(result.notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toEqual([]);
    expect(f.container()).toEqual(container);
    expect(f.management()).toMatchObject({ mode: "off", failure: { stage: "validate" } });
    expect(f.management()!.active).toBeUndefined();
});

test("a competing process that takes over during preparation prevents this cutover", () => {
    const f = setup(); const container = legacyContainer(f);
    const competitor = { id: "competitor", pid: process.pid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z" };
    const state = f.state(); state.mutate = { when: "image inspect", skip: 1, management: { operation: competitor } }; f.setState(state);
    f.apply();
    expect(mutating(f)).toEqual([]);
    expect(f.container()).toEqual(container);
    expect(f.management()!.operation).toEqual(competitor);
    expect(f.management()!.active).toBeUndefined();
});

test("a tag that moves after approval cannot widen the approved image", () => {
    const f = setup();
    const state = f.state(); state.mutate = { when: "image inspect", skip: 1, retag: { tag: infrastructure.HINDSIGHT_IMAGE, image: newId } }; f.setState(state);
    expect(f.apply().notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toEqual([]);
    expect(f.management()).toMatchObject({ failure: { stage: "validate" } });
});

test("a live operation in another process refuses a new approval", () => {
    const f = setup(); legacyContainer(f);
    const other = { id: "other", pid: process.pid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z" };
    f.manage({ operation: other });
    expect(f.apply().notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toEqual([]);
    expect(f.management()!.operation).toEqual(other);
});

test("an interrupted operation authorizes nothing and does not block a new approval", () => {
    const f = setup(); legacyContainer(f);
    f.manage({ mode: "cpu", operation: { id: "interrupted", pid: deadPid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z", candidateImageId: imageId } });
    expect(f.run().notifications.map(n => n.level)).toEqual(["warning"]);
    expect(mutating(f)).toEqual([]);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.management()!.operation).toBeUndefined();
    expect(f.management()!.active.imageId).toBe(imageId);
});

test("failed readiness keeps the previous container and does not report the change as active", () => {
    const f = setup(); legacyContainer(f);
    const state = f.state(); state.health = "unhealthy"; f.setState(state);
    const result = f.apply({ HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" });
    expect(result.notifications.at(-1)?.level).toBe("error");
    const containers = f.state().containers;
    const previous = Object.keys(containers).find(name => name.startsWith("fixture-hindsight-previous-"))!;
    expect(result.notifications.at(-1)?.message).toContain(previous);
    expect(containers[previous]).toMatchObject({ image: imageId, running: false });
    expect(containers["fixture-hindsight"].running).toBe(false);
    expect(f.state().images[imageId]).toBeDefined();
    expect(f.management()).toMatchObject({ mode: "cpu", failure: { stage: "readiness" } });
    expect(f.management()!.active).toBeUndefined();
    expect(f.state().data).toBe("preserved-data");
    expect(status(f)).not.toContain(shortId);
});

test("a container that exits fails readiness without waiting for the timeout", () => {
    const f = setup(); const state = f.state(); state.exitsAfterRun = true; f.setState(state);
    const started = Date.now();
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.management()).toMatchObject({ failure: { stage: "readiness" } });
});

test.each(["before", "after"] as const)("a launch that fails %s container creation restores and restarts the previous container", stage => {
    const f = setup(); const container = legacyContainer(f);
    f.setState({ ...f.state(), runFails: stage === "before", runFailsAfterCreate: stage === "after" });
    expect(f.apply().notifications.at(-1)?.level).toBe("error");
    expect(f.state().containers).toEqual({ "fixture-hindsight": container });
    expect(f.management()).toMatchObject({ failure: { stage: "cutover" } });
    expect(f.management()!.active).toBeUndefined();
});

test("a later success replaces the failure record with the active runtime", () => {
    const f = setup(); const state = f.state(); state.health = "unhealthy"; f.setState(state);
    f.apply({ HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" });
    const healthy = f.state(); delete healthy.health; f.setState(healthy);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.management()!.failure).toBeUndefined();
    expect(f.management()!.active.imageId).toBe(imageId);
});

test("startup starts a stopped approved runtime without preparing anything", () => {
    const f = setup(); f.apply();
    const state = f.state();
    const stopped = state.containers[infrastructure.HINDSIGHT_CONTAINER_NAME];
    stopped.running = false;
    f.setState(state);
    const before = mutating(f).length;
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(mutating(f).slice(before)).toEqual([["start", stopped.id]]);
    expect(f.container()!.running).toBe(true);
});

test("startup recreates a missing container from the approved cached image, not a moved tag", () => {
    const f = setup(); f.apply();
    const state = f.state();
    delete state.containers["fixture-hindsight"];
    state.images[imageId].tags = []; state.images[newId] = { tags: [infrastructure.HINDSIGHT_IMAGE] };
    f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.state().calls.filter(call => ["pull", "build"].includes(call[0]))).toEqual([]);
    expect(f.state().data).toBe("preserved-data");
});

test("startup reports a missing approved image instead of downloading it", () => {
    const f = setup(); f.apply();
    const state = f.state(); delete state.containers["fixture-hindsight"]; delete state.images[imageId]; f.setState(state);
    const before = mutating(f).length;
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toHaveLength(before);
    expect(f.container()).toBeUndefined();
});

test("startup never applies changed provider files implicitly", () => {
    const f = setup(); f.apply();
    f.envFile("providers/primary.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "changed-model" });
    const missing = f.state(); const approved = missing.containers["fixture-hindsight"]; delete missing.containers["fixture-hindsight"]; f.setState(missing);
    const before = mutating(f).length;
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toHaveLength(before);
    const stopped = f.state(); stopped.containers["fixture-hindsight"] = { ...approved, running: false }; f.setState(stopped);
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(f.container()!.running).toBe(true);
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(status(f)).toContain(shortId);
});

test("startup leaves a container that is not the approved runtime untouched", () => {
    const f = setup(); f.apply();
    const state = f.state(); state.containers["fixture-hindsight"].labels = {}; state.containers["fixture-hindsight"].running = false; f.setState(state);
    const before = mutating(f).length;
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(mutating(f)).toHaveLength(before);
    expect(f.container()!.running).toBe(false);
});

test("startup with CPU requested but nothing approved does no Docker work", () => {
    const f = setup(); legacyContainer(f, false); f.manage({ mode: "cpu" });
    expect(f.run().notifications.map(n => n.level)).toEqual(["warning"]);
    expect(f.state().calls).toEqual([]);
});

test("headless and child sessions perform no lifecycle work while management is on", () => {
    const f = setup(); f.apply();
    const state = f.state(); state.containers["fixture-hindsight"].running = false; f.setState(state);
    const before = f.state().calls.length;
    const result = f.run([{ kind: "subagent" }, { hasUI: false }, { hasUI: false, command: true, choices: [menu.apply], confirm: true }]);
    expect(result.notifications).toEqual([]);
    expect(result.tools).toContain("hindsight_evidence");
    expect(f.state().calls).toHaveLength(before);
});

test("eligible startup recovers once per process across reimports", () => {
    const f = setup(); f.apply();
    const state = f.state(); state.containers["fixture-hindsight"].running = false; f.setState(state);
    const result = f.run([{ kind: "subagent" }, { hasUI: false }, {}, {}]);
    expect(result.notifications.map(n => n.level)).toEqual(["info"]);
    expect(f.state().calls.filter(call => call[0] === "start")).toHaveLength(1);
});

test("an unreadable management state pauses management visibly", () => {
    const f = setup(); fs.writeFileSync(path.join(f.root, ".local-management.json"), "{not json");
    expect(f.run().notifications.map(n => n.level)).toEqual(["error"]);
    expect(f.state().calls).toEqual([]);
});
