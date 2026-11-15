import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, imageId, indexDigest, infrastructure, menu, platformDigest, upstreamIndex, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const newIndex = "sha256:" + "c".repeat(64);
const newPlatform = "sha256:" + "d".repeat(64);
const hour = 60 * 60 * 1000;
const registryCalls = (f: Fixture) => f.state().calls.filter(call => call[0] === "buildx" && call[1] === "imagetools");
const preparation = (f: Fixture) => f.state().calls.filter(call => ["run", "start", "stop", "rename", "rm", "pull", "build", "tag", "volume"].includes(call[0]));
const checkNow = (f: Fixture, overrides?: Record<string, string>) => f.run([{ startup: false, command: true, choices: [menu.check] }], overrides);
const status = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.status] }]).notifications.at(-1)!.message;

function publish(f: Fixture, registry: Record<string, unknown>) {
    const state = f.state(); state.registry = registry; f.setState(state);
}
/** An approved runtime whose container is running, as after a successful apply. */
function approved() {
    const f = setup(); f.apply();
    return { f, active: f.management()!.active, before: preparation(f).length };
}

test("startup discovers an update once per 24 hours across processes without preparing or applying it", () => {
    const { f, active, before } = approved();
    publish(f, { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(newIndex, newPlatform) });
    const first = f.run();
    expect(first.dialogs).toEqual([]);
    expect(first.notifications.at(-1)?.level).toBe("info");
    expect(registryCalls(f)).toEqual([["buildx", "imagetools", "inspect", infrastructure.HINDSIGHT_IMAGE, "--format", "{{json .Manifest}}"]]);
    expect(f.management()).toMatchObject({ mode: "cpu", check: { outcome: "available", available: { reference: infrastructure.HINDSIGHT_IMAGE, digest: newPlatform, indexDigest: newIndex } } });
    expect(f.management()!.active).toEqual(active);
    expect(f.management()!.failure).toBeUndefined();
    expect(preparation(f)).toHaveLength(before);
    expect(f.container()).toMatchObject({ image: imageId, running: true });

    expect(f.run().notifications).toHaveLength(1);
    expect(registryCalls(f)).toHaveLength(1);
});

test("a failed background check paces later startups, is redacted and is not reported as current", () => {
    const { f } = approved();
    publish(f, {});
    const failed = f.run();
    expect(failed.notifications.at(-1)?.level).toBe("warning");
    expect(f.management()!.check).toMatchObject({ outcome: "failed" });
    expect(f.management()!.check.available).toBeUndefined();
    const report = status(f);
    const log = fs.readFileSync(path.join(f.root, "hindsight.log"), "utf8");
    for (const text of [JSON.stringify(failed), report, log, JSON.stringify(f.management())]) expect(text).not.toContain("synthetic-registry-secret");

    f.run();
    expect(registryCalls(f)).toHaveLength(1);
    f.manage({ check: { ...f.management()!.check, attemptedAt: Date.now() - 25 * hour } });
    publish(f, { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(indexDigest, platformDigest) });
    f.run();
    expect(registryCalls(f)).toHaveLength(2);
    expect(f.management()!.check).toMatchObject({ outcome: "current" });
});

test("an interrupted check still counts against the background interval", () => {
    const { f } = approved();
    f.manage({ check: { attemptedAt: Date.now() - hour } });
    f.run();
    expect(registryCalls(f)).toEqual([]);
});

test("a manual check bypasses the interval without approving or preparing anything", () => {
    const { f, active, before } = approved();
    f.manage({ check: { attemptedAt: Date.now() - hour, outcome: "current" } });
    publish(f, { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(newIndex, newPlatform) });
    const result = checkNow(f);
    expect(result.dialogs.filter(dialog => dialog.message !== undefined)).toEqual([]);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.management()).toMatchObject({ check: { outcome: "available", available: { digest: newPlatform } } });
    expect(f.management()!.active).toEqual(active);
    expect(f.management()!.operation).toBeUndefined();
    expect(preparation(f)).toHaveLength(before);

    publish(f, { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(indexDigest, platformDigest) });
    expect(checkNow(f).notifications.at(-1)?.level).toBe("info");
    expect(f.management()!.check).toMatchObject({ outcome: "current" });
    expect(f.management()!.check.available).toBeUndefined();
});

test("missing Buildx is unsupported, distinct from a failed or current check", () => {
    const { f } = approved();
    const state = f.state(); state.buildxMissing = true; f.setState(state);
    expect(checkNow(f).notifications.at(-1)?.level).toBe("warning");
    expect(f.management()!.check).toMatchObject({ outcome: "unsupported" });
    const unsupported = status(f);
    const restored = f.state(); delete restored.buildxMissing; restored.registry = {}; f.setState(restored);
    checkNow(f);
    expect(f.management()!.check).toMatchObject({ outcome: "failed" });
    expect(status(f)).not.toEqual(unsupported);
});

test("updates compare registry digests of the configured source, not the local tag or image ID", () => {
    const { f } = approved();
    const state = f.state();
    state.images["sha256:" + "9".repeat(64)] = { tags: [infrastructure.HINDSIGHT_IMAGE, "hindsight-omp-cuda:local"] };
    state.images[imageId].tags = [];
    f.setState(state);
    checkNow(f);
    expect(f.management()!.check).toMatchObject({ outcome: "current" });

    f.manage({ active: { ...f.management()!.active, upstream: { reference: infrastructure.HINDSIGHT_IMAGE, digests: [platformDigest] } } });
    checkNow(f);
    expect(f.management()!.check).toMatchObject({ outcome: "current" });

    publish(f, { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(imageId, newPlatform) });
    checkNow(f);
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { digest: newPlatform, indexDigest: imageId } });
    expect(registryCalls(f).map(call => call[3])).toEqual(Array(3).fill(infrastructure.HINDSIGHT_IMAGE));
});

test("a digest-pinned source is never moved to another digest", () => {
    const { f } = approved();
    const pinned = "fixture/image@" + indexDigest;
    publish(f, { [pinned]: upstreamIndex(indexDigest, platformDigest), [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(newIndex, newPlatform) });
    checkNow(f, { HINDSIGHT_IMAGE: pinned });
    expect(f.management()!.check).toMatchObject({ outcome: "current" });

    publish(f, { [pinned]: upstreamIndex(newIndex, newPlatform) });
    expect(checkNow(f, { HINDSIGHT_IMAGE: pinned }).notifications.at(-1)?.level).toBe("warning");
    expect(f.management()!.check).toMatchObject({ outcome: "failed" });
    expect(f.management()!.check.available).toBeUndefined();
    expect(registryCalls(f).map(call => call[3])).toEqual([pinned, pinned]);
});

test("Off does no registry work, even from the manual check", () => {
    const { f } = approved();
    f.run([{ startup: false, command: true, choices: [menu.mode, "Off"] }]);
    const result = f.run([{}, { startup: false, command: true, choices: [menu.check] }]);
    expect(result.notifications.map(n => n.level)).toEqual(["warning"]);
    expect(registryCalls(f)).toEqual([]);
    expect(f.management()!.check).toBeUndefined();
});

test("headless and child sessions do no registry work while management is on", () => {
    const { f } = approved();
    const result = f.run([{ kind: "subagent" }, { hasUI: false }, { hasUI: false, command: true, choices: [menu.check] }]);
    expect(result.notifications).toEqual([]);
    expect(registryCalls(f)).toEqual([]);
    expect(f.management()!.check).toBeUndefined();
});

test("a check superseded by a newer one leaves the newer result in place", () => {
    const { f } = approved();
    const newer = { attemptedAt: Date.now() + hour, outcome: "available", available: { reference: infrastructure.HINDSIGHT_IMAGE, digest: newPlatform } };
    const state = f.state(); state.mutate = { when: "buildx imagetools", management: { check: newer } }; f.setState(state);
    const result = checkNow(f);
    expect(f.management()!.check).toEqual(newer);
    expect(result.notifications.map(n => n.level)).toEqual(["info"]);
});
