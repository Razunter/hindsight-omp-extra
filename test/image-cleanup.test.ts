import { afterEach, expect, test } from "bun:test";
import { discoverUpdate, fixture, imageId, infrastructure, menu, type DockerState, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const INSTALLATION = "io.github.razunter.hindsight-omp.installation";
const calls = (f: Fixture, name: string) => f.state().calls.filter(call => call[0] === name);
const removals = (f: Fixture) => calls(f, "image").filter(call => call[1] === "rm");
const host = (f: Fixture, patch: Partial<DockerState>) => f.setState({ ...f.state(), ...patch });
const applyUpdate = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }], { HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" });
const status = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.status] }]).notifications.at(-1)!.message;

/** A healthy GPU runtime on the cached upstream image, with a newer upstream release discovered. */
function gpuUpdateAvailable() {
    const f = setup(); f.apply();
    host(f, { gpu: "cuda" });
    expect(f.run([{ startup: false, command: true, choices: [menu.mode, "GPU"], confirm: true }]).notifications.at(-1)?.level).toBe("info");
    const active = f.management()!.active;
    discoverUpdate(f);
    return { f, old: active.imageId as string };
}

/** An owned derivative left by an earlier successful update whose cleanup did not finish. */
function staleDerivative(f: Fixture): string {
    const id = "sha256:" + "5".repeat(64), base = "fixture/image@sha256:" + "9".repeat(64);
    const state = f.state();
    state.images[id] = { tags: ["hindsight-omp-cuda:" + "9".repeat(12)], labels: { [INSTALLATION]: f.management()!.installationId, "io.github.razunter.hindsight-omp.derivative": "cuda", "io.github.razunter.hindsight-omp.base": base } };
    f.setState(state);
    f.manage({ owned: [...f.management()!.owned, { imageId: id, kind: "derivative", base, recordedAt: "2026-11-01T00:00:00.000Z" }] });
    return id;
}

test("a healthy GPU update removes superseded owned derivatives and nothing else", () => {
    const { f, old } = gpuUpdateAvailable();
    const stale = staleDerivative(f);
    const unrelated = {
        ["sha256:" + "6".repeat(64)]: { tags: ["other/app:latest"] },
        ["sha256:" + "7".repeat(64)]: { tags: [] },
        ["sha256:" + "8".repeat(64)]: { tags: ["hindsight-omp-cuda:" + "8".repeat(12)], labels: { [INSTALLATION]: "another-installation", "io.github.razunter.hindsight-omp.derivative": "cuda" } },
    };
    host(f, { images: { ...f.state().images, ...unrelated } });
    f.manage({ cleanupFailure: { message: "an earlier cleanup failed", at: "2026-11-01T00:00:00.000Z" } });

    expect(applyUpdate(f).notifications.at(-1)?.level).toBe("info");
    const rebuilt = f.management()!.active.imageId;
    expect(f.container()).toMatchObject({ image: rebuilt, running: true, gpus: true });
    expect(f.state().images[old]).toBeUndefined();
    expect(f.state().images[stale]).toBeUndefined();
    expect(removals(f).sort()).toEqual([["image", "rm", "--no-prune", old], ["image", "rm", "--no-prune", stale]].sort());
    for (const [id, image] of Object.entries(unrelated)) expect(f.state().images[id]).toEqual(image);
    expect(f.state().images[imageId].tags).toEqual([infrastructure.HINDSIGHT_IMAGE]);
    expect(f.state().images[rebuilt]).toBeDefined();
    expect(f.management()!.owned).toEqual([expect.objectContaining({ imageId: rebuilt, kind: "derivative" })]);
    expect(f.management()!.cleanupFailure).toBeUndefined();
    expect(f.state().calls.filter(call => ["builder", "system", "volume"].includes(call[0]) || call.some(arg => arg === "prune" || arg === "--force" || arg === "-f"))).toEqual([]);
    expect(f.state().data).toBe("preserved-data");
});

test.each([
    ["an unhealthy API", { health: "unhealthy" as const }],
    ["local models still on CPU", { modelDevice: "cpu" }],
    ["a failed CUDA build", { buildFails: true }],
    ["failed GPU validation", { gpu: "no-cuda" as const }],
    ["a failed container launch", { runFails: true }],
])("an update ending in %s removes no image", (_name, patch) => {
    const { f, old } = gpuUpdateAvailable();
    const stale = staleDerivative(f);
    const active = f.management()!.active;
    host(f, patch);
    expect(applyUpdate(f).notifications.at(-1)?.level).toBe("error");
    expect(removals(f)).toEqual([]);
    expect(f.state().images[old]).toBeDefined();
    expect(f.state().images[stale]).toBeDefined();
    expect(f.management()!.active).toEqual(active);
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toEqual(expect.arrayContaining([old, stale]));
});

test.each([
    ["a running container of another deployment", (state: DockerState, old: string) => { state.containers.other = { ...state.containers["fixture-hindsight"], id: "other".padEnd(64, "0"), image: old, running: true, mounts: [], portBindings: {}, labels: {} }; }],
    ["a stopped container of another deployment", (state: DockerState, old: string) => { state.containers.other = { ...state.containers["fixture-hindsight"], id: "other".padEnd(64, "0"), image: old, running: false, mounts: [], portBindings: {}, labels: {} }; }],
    ["an independent tag", (state: DockerState, old: string) => { state.images[old].tags.push("someone/keep:1"); }],
    ["labels of another installation", (state: DockerState, old: string) => { state.images[old].labels![INSTALLATION] = "another-installation"; }],
])("a superseded derivative with %s is kept and stays recorded", (_name, protect) => {
    const { f, old } = gpuUpdateAvailable();
    const state = f.state(); protect(state, old); f.setState(state);
    expect(applyUpdate(f).notifications.at(-1)?.level).toBe("info");
    expect(f.state().images[old]).toBeDefined();
    expect(removals(f)).toEqual([]);
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toContain(old);
    expect(f.management()!.cleanupFailure).toBeUndefined();
});

test("a derivative another operation claims as its candidate during the update is kept", () => {
    const { f, old } = gpuUpdateAvailable();
    const competitor = { id: "competitor", pid: process.pid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z", candidateImageId: old };
    host(f, { mutate: { when: "exec", skip: calls(f, "exec").length, management: { operation: competitor } } });
    expect(applyUpdate(f).notifications.at(-1)?.level).toBe("info");
    expect(f.state().images[old]).toBeDefined();
    expect(removals(f)).toEqual([]);
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toContain(old);
});

test("Off chosen while the current container is inspected for cutover stops nothing and replaces nothing", () => {
    const { f, old } = gpuUpdateAvailable();
    const running = f.container();
    // The second container inspection of this apply is the cutover's, after preparation and GPU validation.
    host(f, { mutate: { when: "container inspect", skip: calls(f, "container").length + 1, management: { mode: "off" } } });
    const before = f.state().calls.length;
    expect(applyUpdate(f).notifications.at(-1)?.level).toBe("warning");
    expect(f.state().calls.slice(before).filter(call => ["stop", "rename", "rm"].includes(call[0]) || (call[0] === "run" && call[1] === "-d"))).toEqual([]);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ mode: "off", active: { imageId: old }, failure: { stage: "validate" } });
});

test.each([
    ["the old container is stopped", "stop"],
    ["the new container's readiness is checked", "exec"],
])("Off chosen while %s finishes the committed handoff but keeps superseded images, and says so", (_name, when) => {
    const { f, old } = gpuUpdateAvailable();
    const stale = staleDerivative(f);
    host(f, { mutate: { when, skip: calls(f, when).length, management: { mode: "off" } } });
    const outcome = applyUpdate(f).notifications.at(-1)!;
    expect(outcome.level).toBe("warning");
    expect(outcome.message).toContain("runtime ready");
    expect(outcome.message).toContain("turned Off");
    const rebuilt = f.management()!.active.imageId;
    expect(rebuilt).not.toBe(old);
    expect(f.container()).toMatchObject({ image: rebuilt, running: true, gpus: true });
    expect(f.management()!.mode).toBe("off");
    expect(removals(f)).toEqual([]);
    expect(f.state().images[old]).toBeDefined();
    expect(f.state().images[stale]).toBeDefined();
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toEqual(expect.arrayContaining([old, stale]));
    expect(f.management()!.cleanupFailure.message).toContain("turned Off");
});

test("Off chosen during cleanup stops it before the next image", () => {
    const { f } = gpuUpdateAvailable();
    staleDerivative(f);
    host(f, { mutate: { when: "image rm", skip: removals(f).length, management: { mode: "off" } } });
    expect(applyUpdate(f).notifications.at(-1)?.message).toContain("turned Off");
    expect(removals(f)).toHaveLength(1);
    expect(f.management()!.owned).toHaveLength(2);
});

test("an image Docker fails to inspect during cleanup stays recorded and is reported, not taken as gone", () => {
    const { f } = gpuUpdateAvailable();
    const stale = staleDerivative(f);
    host(f, { imageInspectFails: [stale] });
    const outcome = applyUpdate(f).notifications.at(-1)!;
    expect(outcome.level).toBe("warning");
    expect(outcome.message).toContain(stale.slice(7, 19));
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toContain(stale);
    expect(f.management()!.cleanupFailure.message).toContain(stale.slice(7, 19));
});

test("a failed deletion is reported with the image while the runtime stays ready, and a later clean run clears it", () => {
    const { f, old } = gpuUpdateAvailable();
    host(f, { imageRemoveFails: true });
    const outcome = applyUpdate(f).notifications.at(-1)!;
    expect(outcome.level).toBe("warning");
    expect(outcome.message).toContain("runtime ready");
    expect(outcome.message).toContain(old.slice(7, 19));
    const rebuilt = f.management()!.active.imageId;
    expect(f.container()).toMatchObject({ image: rebuilt, running: true, gpus: true });
    expect(f.state().images[old]).toBeDefined();
    expect(f.management()!.failure).toBeUndefined();
    expect(f.management()!.cleanupFailure.message).toContain(old.slice(7, 19));
    expect(f.management()!.owned.map((entry: { imageId: string }) => entry.imageId)).toContain(old);
    const shown = status(f);
    expect(shown).toContain(rebuilt.slice(7, 19));
    expect(shown).toContain(old.slice(7, 19));
    expect(shown).not.toContain("Last failure");

    host(f, { imageRemoveFails: false });
    expect(f.run([{ startup: false, command: true, choices: [menu.mode, "CPU"], confirm: true }]).notifications.at(-1)?.level).toBe("info");
    expect(f.state().images[old]).toBeUndefined();
    expect(f.state().images[rebuilt]).toBeDefined();
    expect(f.management()!.cleanupFailure).toBeUndefined();
    expect(f.management()!.owned).toEqual([expect.objectContaining({ imageId: rebuilt })]);
});
