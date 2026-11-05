import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, profile, nativeEnv, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

test("picker discovers contained names and persists only the selected name without Docker", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    fs.writeFileSync(path.join(f.root, "outside.env"), "synthetic-secret");
    fs.symlinkSync("../outside.env", path.join(f.root, "providers/escape.env"));
    fs.mkdirSync(path.join(f.root, "providers/not-file.env"));
    const before = fs.readFileSync(path.join(f.root, "providers/other.env"), "utf8");
    const result = f.run([{ startup: false, command: true, choice: "other" }]);
    expect(result.dialogs[0].options).toEqual(["other", "primary"]);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("other\n");
    expect(fs.readFileSync(path.join(f.root, "providers/other.env"), "utf8")).toBe(before);
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.state().calls).toEqual([]);
});

test.each([undefined, "../outside", "unknown", ""])("cancel or invalid result %j preserves prior saved bytes", choice => {
    const f = setup(); f.select("primary\n");
    f.run([{ startup: false, command: true, choice }]);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});

test("profile disappearance during the dialog cannot replace the saved choice", () => {
    const f = setup(); f.envFile("providers/other.env", profile);
    const result = f.run([{ startup: false, command: true, choice: "other", removeProfile: "other" }]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});

test("failed atomic selection write preserves old bytes and leaves no temporary record", () => {
    const f = setup(); f.envFile("providers/other.env", profile);
    const result = f.run([{ startup: false, command: true, choice: "other", failWrite: true }]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(fs.readdirSync(f.root).filter(name => name.startsWith(".selected-provider."))).toEqual([]);
    expect(f.state().calls).toEqual([]);
});

test("saving through the picker does not apply on session creation/reimport but does in a fresh process", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    f.run([{}, { command: true, choice: "other" }, {}]);
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(f.state().calls.filter(a => a[0] === "version")).toHaveLength(1);
    f.run();
    expect(nativeEnv(f.state()).HINDSIGHT_API_LLM_MODEL).toBe("other-model");
});

test("empty profile directory reports a setup error rather than opening an empty dialog", () => {
    const f = setup(); fs.unlinkSync(path.join(f.root, "providers/primary.env"));
    const result = f.run([{ startup: false, command: true }]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(result.dialogs).toEqual([]);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});
