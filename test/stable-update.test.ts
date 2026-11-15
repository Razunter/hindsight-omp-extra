import { afterEach, expect, test } from "bun:test";
import { STABLE_IMAGE } from "../src/stable-release";
import { fixture, imageId, indexDigest, infrastructure, menu, update, upstreamIndex, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });
const repository = "ghcr.io/vectorize-io/hindsight";
const release = { tag_name: "v1.2.1", draft: false, prerelease: false };
const releaseUrl = "https://github.com/vectorize-io/hindsight/releases/tag/v1.2.1";
const check = (f: Fixture, overrides?: Record<string, string>) => f.run([{ startup: false, command: true, choices: [menu.check] }], overrides);
const mutations = (f: Fixture) => f.state().calls.filter(call => ["run", "pull", "build", "stop", "rename", "rm", "tag"].includes(call[0]));

function setup(): Fixture {
    const f = fixture(); owned.push(f);
    f.apply();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_IMAGE: STABLE_IMAGE });
    f.manage({ active: { ...f.management()!.active, upstream: { reference: STABLE_IMAGE, digests: [indexDigest] } } });
    const state = f.state();
    state.images[imageId] = { tags: [STABLE_IMAGE], digests: [`${repository}@${indexDigest}`] };
    state.registry = { [`${repository}:1.2.1`]: upstreamIndex(update.index, update.platform), [STABLE_IMAGE]: upstreamIndex("sha256:" + "e".repeat(64), "sha256:" + "f".repeat(64)) };
    state.remote = { [`${repository}@${update.platform}`]: update.imageId };
    state.stableRelease = { body: release };
    f.setState(state);
    return f;
}

test.each(["cpu", "gpu"])("%s updates use the discovered stable digest and print its version URL", mode => {
    const f = setup();
    const state = f.state(); state.gpu = "cuda"; f.setState(state);
    f.manage({ mode });
    const active = f.management()!.active;
    const before = mutations(f);
    const result = check(f);
    const notice = result.notifications.at(-1)!.message;
    expect(notice).toContain("stable 1.2.1");
    expect(notice).toContain(releaseUrl);
    expect(notice).not.toContain("sha256:");
    const status = f.run([{ startup: false, command: true, choices: [menu.status] }]);
    expect(status.notifications.at(-1)?.message).toContain(releaseUrl);
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { digest: update.platform, release: { version: "1.2.1", url: releaseUrl, image: `${repository}:1.2.1` } } });
    expect(f.management()!.active).toEqual(active);
    expect(mutations(f)).toEqual(before);
    const cancelled = f.run([{ startup: false, command: true, choices: [menu.update], confirm: false }]);
    expect(cancelled.dialogs.find(dialog => dialog.message)?.message).toContain(update.platform);
    expect(mutations(f)).toEqual(before);

    const moved = f.state();
    moved.stableRelease = { body: { ...release, tag_name: "v1.2.2" } };
    moved.registry = {};
    f.setState(moved);
    const applied = f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }]);
    expect(applied.notifications.at(-1)?.message).toContain("runtime ready");
    expect(f.management()!.active).toMatchObject({ mode, upstream: { reference: STABLE_IMAGE, digests: [update.platform, update.index] } });
    expect(f.management()!.check.outcome).toBe("current");
    if (mode === "gpu") {
        expect(f.state().buildContext?.buildArgs).toContain(`BASE=${repository}@${update.platform}`);
        expect(f.container()?.gpus).toBe(true);
    } else {
        expect(f.state().calls.filter(call => call[0] === "pull")).toEqual([["pull", `${repository}@${update.platform}`]]);
        expect(f.container()?.image).toBe(update.imageId);
    }
});

test("a matching stable release is current even when latest points elsewhere", () => {
    const f = setup();
    const state = f.state(); state.registry![`${repository}:1.2.1`] = upstreamIndex(indexDigest, "sha256:" + "b".repeat(64)); f.setState(state);
    check(f);
    expect(f.management()!.check.outcome).toBe("current");
    expect(f.management()!.check.available).toBeUndefined();
});

test.each([
    { body: { ...release, prerelease: true } },
    { body: { ...release, draft: true } },
    { body: { ...release, tag_name: "v1.3.0-rc.1" } },
    { body: { ...release, tag_name: "v1.2.1\n--option" } },
    { body: null },
    { status: 403 },
    { networkError: true },
])("unusable stable metadata fails without falling back to latest (%j)", metadata => {
    const f = setup();
    const state = f.state(); state.stableRelease = metadata; f.setState(state);
    const active = f.management()!.active;
    const before = mutations(f);
    const failed = check(f);
    expect(failed.notifications.at(-1)?.level).toBe("warning");
    expect(JSON.stringify(failed)).not.toContain("synthetic-release-secret");
    expect(f.management()!.check).toMatchObject({ outcome: "failed" });
    expect(f.management()!.check.available).toBeUndefined();
    expect(f.state().calls.filter(call => call[0] === "buildx")).toEqual([]);
    f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }]);
    expect(f.management()!.active).toEqual(active);
    expect(mutations(f)).toEqual(before);
});

test("a missing stable image fails instead of offering the moving latest image", () => {
    const f = setup();
    const state = f.state(); delete state.registry![`${repository}:1.2.1`]; f.setState(state);
    check(f);
    expect(f.management()!.check.outcome).toBe("failed");
    expect(f.management()!.check.available).toBeUndefined();
});

test("old latest-only offers cannot authorize a stable update", () => {
    const f = setup();
    f.manage({ check: { attemptedAt: Date.now(), outcome: "available", available: { reference: STABLE_IMAGE, digest: update.platform, indexDigest: update.index } } });
    const before = mutations(f);
    const result = f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }]);
    expect(result.dialogs.filter(dialog => dialog.message)).toEqual([]);
    expect(mutations(f)).toEqual(before);
    expect(f.management()!.active.imageId).toBe(imageId);
});

test("an explicit official version pin does not follow GitHub releases", () => {
    const f = setup();
    check(f, { HINDSIGHT_IMAGE: `${repository}:1.2.1` });
    expect(f.state().releaseRequests).toBeUndefined();
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { reference: `${repository}:1.2.1`, digest: update.platform } });
});

test("startup prints the stable release URL once per day and stays out of Off and child sessions", () => {
    const f = setup();
    const background = f.run();
    expect(background.notifications.at(-1)?.message).toContain(releaseUrl);
    expect(f.run().notifications.some(notice => notice.message.includes(releaseUrl))).toBe(false);
    expect(f.state().releaseRequests).toHaveLength(1);
    f.manage({ check: undefined });
    f.run([{ kind: "subagent" }, { hasUI: false }]);
    f.manage({ mode: "off" });
    f.run([{}, { startup: false, command: true, choices: [menu.check] }]);
    expect(f.state().releaseRequests).toHaveLength(1);
});

test.each(["cpu", "gpu"])("a first %s installation checks stable before using a cached latest image", mode => {
    const f = fixture(); owned.push(f);
    f.envFile(".env", { ...infrastructure, HINDSIGHT_IMAGE: STABLE_IMAGE });
    const state = f.state();
    state.images[imageId] = { tags: [STABLE_IMAGE], digests: [`${repository}@${indexDigest}`] };
    state.registry = { [`${repository}:1.2.1`]: upstreamIndex(update.index, update.platform) };
    state.remote = { [`${repository}@${update.platform}`]: update.imageId };
    state.stableRelease = { body: release };
    state.gpu = "cuda";
    f.setState(state);
    f.manage({ mode });
    f.run([{ startup: false, command: true, choices: [menu.apply], confirm: true }]);
    expect(f.management()!.active).toBeUndefined();
    expect(mutations(f)).toEqual([]);
    f.run([{ startup: false, command: true, choices: [menu.apply], confirm: true }]);
    expect(f.management()!.active.mode).toBe(mode);
    if (mode === "cpu") expect(f.container()?.image).toBe(update.imageId);
    else expect(f.state().buildContext?.buildArgs).toContain(`BASE=${repository}@${update.platform}`);
    expect(f.management()!.active.upstream.digests).toEqual([update.platform, update.index]);
});

test("a requested configuration change keeps the approved image while stable is pending", () => {
    const f = setup();
    check(f);
    const applied = f.apply();
    expect(applied.notifications.at(-1)?.message).toContain("runtime ready");
    expect(f.management()!.active.upstream.digests).toEqual([indexDigest]);
    expect(f.management()!.check.outcome).toBe("available");
    expect(f.container()?.image).toBe(imageId);
});

test.each([true, false])("a digest-less approved CPU image never takes a pending update, cached=%s", cached => {
    const f = setup();
    f.manage({ active: { ...f.management()!.active, upstream: { reference: STABLE_IMAGE, digests: [] } } });
    const state = f.state();
    if (cached) state.images[imageId].digests = [];
    else delete state.images[imageId];
    f.setState(state);
    check(f);
    const before = mutations(f);
    const result = f.apply();
    expect(f.management()!.active).toMatchObject({ imageId, upstream: { digests: [] } });
    expect(f.management()!.check.outcome).toBe("available");
    expect(f.container()?.image).toBe(imageId);
    expect(f.state().calls.filter(call => call[0] === "pull")).toEqual([]);
    if (cached) expect(result.notifications.at(-1)?.message).toContain("runtime ready");
    else {
        expect(result.notifications.at(-1)?.level).toBe("warning");
        expect(mutations(f)).toEqual(before);
    }
});
