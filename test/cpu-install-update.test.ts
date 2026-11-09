import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { discoverUpdate, fixture, imageId, indexDigest, infrastructure, menu, nativeEnv, platformDigest, profile, update, type Container, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const tag = infrastructure.HINDSIGHT_IMAGE;
const competitor = { id: "competitor", pid: process.pid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z" };
const calls = (f: Fixture, ...names: string[]) => f.state().calls.filter(call => names.includes(call[0]));
const cutover = (f: Fixture) => calls(f, "stop", "rename", "run", "rm", "tag").length;
const approve = (f: Fixture, step: Record<string, unknown> = {}, overrides?: Record<string, string>) =>
    f.run([{ startup: false, command: true, choices: [menu.update], confirm: true, ...step }], overrides);
const applyRequested = { choices: [menu.apply] };
const confirmations = (result: { dialogs: { message?: string }[] }) => result.dialogs.filter(dialog => dialog.message !== undefined);
const status = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.status] }]).notifications.at(-1)!.message;

/** An approved runtime running the cached image, with a newer upstream release discovered. */
function updateAvailable(): { f: Fixture; running: Container; active: Record<string, unknown> } {
    const f = setup(); f.apply(); discoverUpdate(f);
    return { f, running: f.container()!, active: f.management()!.active };
}

test("a first installation discovers the registry target, then downloads it only after one approval", () => {
    const f = setup();
    const state = f.state(); state.images = {}; state.remote = { ["fixture/image@" + platformDigest]: imageId }; f.setState(state);
    f.manage({ mode: "cpu" });
    const discovery = approve(f, applyRequested);
    expect(confirmations(discovery)).toEqual([]);
    expect(calls(f, "pull", "run")).toEqual([]);
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { digest: platformDigest, indexDigest } });

    const result = approve(f, applyRequested);
    expect(confirmations(result)).toHaveLength(1);
    expect(confirmations(result)[0].message).toContain("fixture/image@" + platformDigest);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(calls(f, "pull")).toEqual([["pull", "fixture/image@" + platformDigest]]);
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.state().images[imageId].tags).toEqual([tag]);
    expect(f.management()).toMatchObject({
        active: { imageId, upstream: { reference: tag, digests: [platformDigest, indexDigest] } },
        check: { outcome: "current" },
        owned: [{ imageId, kind: "download" }],
    });
});

test("declining an offered update downloads, builds and restarts nothing", () => {
    const { f, running, active } = updateAvailable();
    const before = f.state().calls.length;
    const result = approve(f, { confirm: false });
    expect(confirmations(result)[0].message).toContain(update.pull);
    expect(f.state().calls.slice(before).filter(call => ["pull", "build", "stop", "rename", "run", "rm", "tag"].includes(call[0]))).toEqual([]);
    expect(f.container()).toEqual(running);
    expect(f.management()!.active).toEqual(active);
    expect(f.management()!.check).toMatchObject({ outcome: "available" });
});

test("an approved update downloads while the service runs, reuses its data and removes the superseded image", () => {
    const { f, running } = updateAvailable();
    const before = f.state().calls.length;
    const result = approve(f);
    expect(confirmations(result)).toHaveLength(1);
    expect(confirmations(result)[0].message).toContain(update.pull);
    expect(confirmations(result)[0].message).toMatch(/migrate/);
    expect(result.notifications.at(-1)?.level).toBe("info");

    const order = f.state().calls.slice(before).map(call => call[0]);
    expect(order.indexOf("pull")).toBeLessThan(order.indexOf("stop"));
    expect(f.state().sharedVolumeRun).toBeUndefined();
    expect(Object.keys(f.state().containers)).toEqual(["fixture-hindsight"]);
    expect(f.container()).toMatchObject({ image: update.imageId, running: true, mounts: running.mounts, portBindings: running.portBindings, shmSize: running.shmSize });
    expect(nativeEnv(f.container())).toEqual(nativeEnv(running));
    expect(f.state().data).toBe("preserved-data");
    expect(f.state().images[update.imageId].tags).toEqual([tag]);
    expect(f.state().images[imageId]).toBeUndefined();
    expect(calls(f, "image").filter(call => call[1] === "rm")).toEqual([["image", "rm", "--no-prune", imageId]]);
    expect(f.management()).toMatchObject({ active: { imageId: update.imageId, upstream: { reference: tag, digests: [update.platform, update.index] } }, check: { outcome: "current" } });
    expect(f.management()!.failure).toBeUndefined();
    expect(f.management()!.cleanupFailure).toBeUndefined();
    expect(JSON.stringify(f.state().calls)).not.toContain(profile.HINDSIGHT_API_LLM_API_KEY);

    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(calls(f, "pull")).toHaveLength(1);
});

test.each(["another tag", "a stopped container"])("a superseded image with %s is kept after a healthy update", ownership => {
    const { f, running } = updateAvailable();
    const state = f.state();
    if (ownership === "another tag") state.images[imageId].tags.push("independent/image:keep");
    else state.containers["other-deployment"] = { ...running, id: "other".padEnd(64, "0"), running: false, mounts: [], labels: {} };
    f.setState(state);
    expect(approve(f).notifications.at(-1)?.level).toBe("info");
    expect(f.state().images[imageId]).toBeDefined();
    expect(f.management()!.active.imageId).toBe(update.imageId);
    expect(f.management()!.cleanupFailure).toBeUndefined();
});

test("a cleanup failure is reported separately while the new runtime stays active", () => {
    const { f } = updateAvailable();
    const state = f.state(); state.imageRemoveFails = true; f.setState(state);
    expect(approve(f).notifications.at(-1)?.level).toBe("warning");
    expect(f.container()).toMatchObject({ image: update.imageId, running: true });
    expect(f.state().images[imageId]).toBeDefined();
    expect(f.management()!.active.imageId).toBe(update.imageId);
    expect(f.management()!.failure).toBeUndefined();
    expect(f.management()!.cleanupFailure).toBeDefined();
    expect(status(f)).toContain(update.imageId.slice(7, 19));
});

test("a tag or check that moves after approval cannot widen the approved download", () => {
    const { f } = updateAvailable();
    const moved = "sha256:" + "3".repeat(64), later = "sha256:" + "4".repeat(64);
    const state = f.state();
    state.mutate = { when: "pull", management: { check: { attemptedAt: Date.now(), outcome: "available", available: { reference: tag, digest: later } } }, retag: { tag, image: moved } };
    f.setState(state);
    expect(approve(f).notifications.at(-1)?.level).toBe("info");
    expect(calls(f, "pull")).toEqual([["pull", update.pull]]);
    expect(f.container()!.image).toBe(update.imageId);
    expect(f.management()!.active).toMatchObject({ imageId: update.imageId, upstream: { digests: [update.platform, update.index] } });
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { digest: later } });
    expect(f.state().images[moved]).toBeDefined();
});

test.each([
    ["Off", { mode: "off" }],
    ["a competing process", { operation: competitor }],
])("%s during the download prevents the cutover and keeps both images", (_name, management) => {
    const { f, running, active } = updateAvailable();
    const before = cutover(f);
    const state = f.state(); state.mutate = { when: "pull", management }; state.waitForHandler = true; f.setState(state);
    expect(approve(f).notifications.at(-1)?.level).toBe("warning");
    expect(cutover(f)).toBe(before);
    expect(f.container()).toEqual(running);
    expect(f.state().images[imageId].tags).toEqual([tag]);
    expect(f.state().images[update.imageId]).toBeDefined();
    expect(f.management()).toMatchObject({ ...management, active, failure: { stage: "validate" }, owned: [{ imageId: update.imageId, kind: "download" }] });
});

test("Off chosen while the download confirmation is open downloads nothing", () => {
    const { f, running, active } = updateAvailable();
    const before = cutover(f);
    expect(approve(f, { afterConfirm: { mode: "off" } }).notifications.at(-1)?.level).toBe("warning");
    expect(calls(f, "pull")).toEqual([]);
    expect(cutover(f)).toBe(before);
    expect(f.container()).toEqual(running);
    expect(f.state().images[update.imageId]).toBeUndefined();
    expect(f.management()).toMatchObject({ mode: "off", active, failure: { stage: "validate" } });
});

test.each([
    ["while the confirmation is open", "confirm"],
    ["during the download", "pull"],
])("an update another process completes %s voids this approval", (_name, when) => {
    const { f, running, active } = updateAvailable();
    const competing = { ...active, imageId: "sha256:" + "9".repeat(64), appliedAt: "2026-11-09T12:00:00.000Z" };
    if (when === "pull") { const state = f.state(); state.mutate = { when, management: { active: competing } }; f.setState(state); }
    const before = cutover(f);
    const result = approve(f, when === "confirm" ? { afterConfirm: { active: competing } } : {});
    expect(result.notifications.at(-1)?.level).toBe("warning");
    expect(result.notifications.at(-1)?.message).toContain("another process applied a runtime");
    expect(calls(f, "pull")).toHaveLength(when === "pull" ? 1 : 0);
    expect(cutover(f)).toBe(before);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ active: competing, failure: { stage: "validate" } });
});

test("an update image already cached without its digest is never owned, so a later cleanup keeps it", () => {
    const { f, active } = updateAvailable();
    const state = f.state(); state.images[update.imageId] = { tags: [] }; state.health = "unhealthy"; f.setState(state);
    expect(approve(f, {}, { HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" }).notifications.at(-1)?.level).toBe("error");
    expect(f.state().images[update.imageId].digests).toEqual([update.pull]);
    expect(f.management()!.owned).toBeUndefined();

    // The owner discards the preserved previous container and reapplies the approved runtime: a healthy cutover, which runs cleanup.
    const healthy = f.state(); delete healthy.health;
    for (const name of Object.keys(healthy.containers)) if (name.startsWith("fixture-hindsight-previous-")) delete healthy.containers[name];
    f.setState(healthy);
    expect(approve(f, applyRequested).notifications.at(-1)?.level).toBe("info");
    expect(f.management()!.active.imageId).toBe(active.imageId);
    expect(f.state().images[update.imageId]).toBeDefined();
    expect(calls(f, "image").filter(call => call[1] === "rm")).toEqual([]);
});

test("a failing download keeps the service and approved runtime and exposes no registry output", () => {
    const { f, running, active } = updateAvailable();
    const before = cutover(f);
    const state = f.state(); state.remote = {}; f.setState(state);
    const result = approve(f);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(cutover(f)).toBe(before);
    expect(f.container()).toEqual(running);
    expect(f.state().images[imageId].tags).toEqual([tag]);
    expect(f.management()).toMatchObject({ mode: "cpu", active, failure: { stage: "prepare" } });
    expect(f.management()!.operation).toBeUndefined();
    const log = fs.readFileSync(path.join(f.root, "hindsight.log"), "utf8");
    for (const text of [JSON.stringify(result), status(f), log, JSON.stringify(f.management())]) expect(text).not.toContain("synthetic-registry-secret");
});

test("an unhealthy replacement preserves the previous container and both images", () => {
    const { f, active } = updateAvailable();
    const state = f.state(); state.health = "unhealthy"; f.setState(state);
    const result = approve(f, {}, { HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" });
    expect(result.notifications.at(-1)?.level).toBe("error");
    const containers = f.state().containers;
    const previous = Object.keys(containers).find(name => name.startsWith("fixture-hindsight-previous-"))!;
    expect(result.notifications.at(-1)?.message).toContain(previous);
    expect(containers[previous]).toMatchObject({ image: imageId, running: false });
    expect(containers["fixture-hindsight"]).toMatchObject({ image: update.imageId, running: false });
    expect(f.state().images[imageId].tags).toEqual([tag]);
    expect(f.state().images[update.imageId]).toBeDefined();
    expect(calls(f, "image").filter(call => call[1] === "rm")).toEqual([]);
    expect(f.management()).toMatchObject({ active, failure: { stage: "readiness" } });
    expect(f.state().data).toBe("preserved-data");
});

test("a missing approved image is downloaded again by its approved digest only through approval", () => {
    const f = setup(); f.apply();
    const active = f.management()!.active;
    const state = f.state();
    delete state.containers["fixture-hindsight"]; delete state.images[imageId];
    state.remote = { ["fixture/image@" + indexDigest]: imageId };
    f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(calls(f, "pull")).toEqual([]);

    const result = approve(f, applyRequested);
    expect(confirmations(result)[0].message).toContain("fixture/image@" + indexDigest);
    expect(confirmations(result)[0].message).not.toMatch(/migrate/);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(calls(f, "pull")).toEqual([["pull", "fixture/image@" + indexDigest]]);
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.management()!.active).toMatchObject({ imageId, upstream: active.upstream });
});

test("a provider change applies on the approved image while an update is pending, and the update stays offered", () => {
    const { f, running } = updateAvailable();
    f.envFile("providers/secondary.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "secondary-model" });
    const result = f.run([{ startup: false, command: true, choices: [menu.provider, "secondary"], confirm: true }]);
    expect(confirmations(result)).toHaveLength(1);
    expect(confirmations(result)[0].message).not.toContain(update.pull);
    expect(confirmations(result)[0].message).not.toMatch(/migrate/);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(calls(f, "pull")).toEqual([]);
    expect(f.container()).toMatchObject({ image: imageId, running: true, mounts: running.mounts });
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("secondary-model");
    expect(f.management()).toMatchObject({ active: { provider: "secondary", imageId }, check: { outcome: "available" } });

    expect(approve(f).notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: update.imageId, running: true });
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("secondary-model");
});

test("the update action without a recorded update changes nothing", () => {
    const f = setup(); f.apply();
    const running = f.container(); const before = f.state().calls.length;
    const result = approve(f);
    expect(confirmations(result)).toEqual([]);
    expect(f.state().calls.slice(before).filter(call => ["pull", "build", "stop", "run"].includes(call[0]))).toEqual([]);
    expect(f.container()).toEqual(running);
});
