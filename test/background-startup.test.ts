import { afterEach, expect, test } from "bun:test";
import { discoverUpdate, fixture, imageId, indexDigest, infrastructure, menu, update, upstreamIndex, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const approve = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }]);

test.each([false, true])("an approved download starts after the handler returns and reports progress and outcome (download fails: %j)", downloadFails => {
    const f = setup(); f.apply(); discoverUpdate(f);
    const state = f.state();
    state.waitForHandler = true;
    if (downloadFails) state.remote = {};
    f.setState(state);
    const result = approve(f);
    expect(f.state().released).toBe(true);
    expect(result.notifications.map(n => n.level)).toEqual(downloadFails ? ["info", "error"] : ["info", "info"]);
    expect(f.container()).toMatchObject({ image: downloadFails ? imageId : update.imageId, running: true });
    expect(f.state().data).toBe("preserved-data");
    expect(f.management()!.operation).toBeUndefined();
});

test.each([false, true])("approval of a cached runtime returns before cutover and reports the eventual result (run fails: %j)", runFails => {
    const f = setup();
    const state = f.state();
    state.waitForHandler = true;
    state.runFails = runFails;
    f.setState(state);
    const result = f.apply();
    expect(f.state().released).toBe(true);
    expect(result.notifications.at(-1)?.level).toBe(runFails ? "error" : "info");
    expect(f.container()?.running ?? false).toBe(!runFails);
    expect(f.management()!.operation).toBeUndefined();
});

test("startup returns before the registry answers and reports an available update afterwards", () => {
    const f = setup(); f.apply();
    const state = f.state();
    state.waitForHandler = true;
    state.registry = { [infrastructure.HINDSIGHT_IMAGE]: upstreamIndex(update.index, update.platform) };
    f.setState(state);
    const result = f.run();
    expect(f.state().released).toBe(true);
    expect(result.notifications.at(-1)).toMatchObject({ level: "info", message: expect.stringContaining(update.platform) });
    expect(f.management()!.active.upstream.digests).toEqual([indexDigest]);
});

test("verbose Docker output on both pipes cannot block a download or the cutover", () => {
    const f = setup(); f.apply(); discoverUpdate(f);
    const state = f.state();
    state.outputBytes = 2 * 1024 * 1024;
    f.setState(state);
    expect(approve(f).notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: update.imageId, running: true });
});
