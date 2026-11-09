import { afterEach, expect, test } from "bun:test";
import { fixture, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

test.each([false, true])("approval returns before cutover and reports the eventual result (run fails: %j)", runFails => {
    const f = setup();
    const state = f.state();
    state.waitForHandler = true;
    state.runFails = runFails;
    f.setState(state);
    const result = f.apply();
    expect(f.state().runReleased).toBe(true);
    expect(result.notifications.at(-1)?.level).toBe(runFails ? "error" : "info");
    expect(f.state().data).toBe("preserved-data");
    expect(f.container()?.running ?? false).toBe(!runFails);
    expect(f.management()!.operation).toBeUndefined();
});

test("verbose Docker output on both pipes cannot block the cutover", () => {
    const f = setup();
    const state = f.state();
    state.outputBytes = 2 * 1024 * 1024;
    f.setState(state);
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.container()?.running).toBe(true);
});
