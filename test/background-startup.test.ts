import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

test.each([false, true])("startup returns during a pull and reports its eventual result (run fails: %j)", runFails => {
    const f = setup();
    const state = f.state();
    state.waitForStartup = true;
    state.pullImage = "sha256:" + "2".repeat(64);
    state.runFails = runFails;
    f.setState(state);
    const result = f.run();
    expect(f.state().pullReleased).toBe(true);
    expect(result.notifications.at(-1)?.level).toBe(runFails ? "error" : "info");
    expect(f.state().data).toBe("preserved-data");
    expect(Object.keys(f.state().images)).toEqual(runFails ? [] : [state.pullImage]);
    expect(f.state().container?.running ?? false).toBe(!runFails);
});

test("verbose pull output on both pipes cannot block reconciliation", () => {
    const f = setup();
    const state = f.state();
    state.pullOutputBytes = 2 * 1024 * 1024;
    f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.state().container?.running).toBe(true);
    expect(fs.existsSync(path.join(f.root, ".last-image-check"))).toBe(true);
});
