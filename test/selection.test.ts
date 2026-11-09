import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, menu, nativeEnv, profile, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const pick = (choice?: string, step: Record<string, unknown> = {}) => [{ startup: false, command: true, choices: [menu.provider, ...(choice === undefined ? [] : [choice])], ...step }];

test("picker discovers contained names and in Off mode persists only the selected name without Docker", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    fs.writeFileSync(path.join(f.root, "outside.env"), "synthetic-secret");
    fs.symlinkSync("../outside.env", path.join(f.root, "providers/escape.env"));
    fs.mkdirSync(path.join(f.root, "providers/not-file.env"));
    const before = fs.readFileSync(path.join(f.root, "providers/other.env"), "utf8");
    const result = f.run(pick("other"));
    expect(result.dialogs.at(-1)!.options).toEqual(["other", "primary"]);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("other\n");
    expect(fs.readFileSync(path.join(f.root, "providers/other.env"), "utf8")).toBe(before);
    expect(JSON.stringify(result)).not.toContain("synthetic-profile-key");
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.state().calls).toEqual([]);
    expect(f.management()).toBeUndefined();
});

test.each([undefined, "../outside", "unknown", ""])("cancel or invalid result %j preserves prior saved bytes", choice => {
    const f = setup(); f.select("primary\n");
    f.run(pick(choice));
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});

test("profile disappearance during the dialog cannot replace the saved choice", () => {
    const f = setup(); f.envFile("providers/other.env", profile);
    const result = f.run(pick("other", { removeProfile: "other" }));
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});

test("failed atomic selection write preserves old bytes and leaves no temporary record", () => {
    const f = setup(); f.envFile("providers/other.env", profile);
    const result = f.run(pick("other", { failWrite: true }));
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(fs.readdirSync(f.root).filter(name => name.startsWith(".selected-provider."))).toEqual([]);
    expect(f.state().calls).toEqual([]);
});

test("with CPU management, a new selection is applied in the current process only after approval", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    f.apply();
    const declined = f.run(pick("other", { confirm: false }));
    expect(declined.dialogs.filter(dialog => dialog.message !== undefined)).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("other\n");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("fixture-model");
    expect(f.management()!.active.provider).toBe("primary");
    expect(f.run(pick("other", { confirm: true })).notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_LLM_MODEL).toBe("other-model");
    expect(f.management()!.active.provider).toBe("other");
    expect(f.state().data).toBe("preserved-data");
});

test("selection state is shared by every process of the installation", () => {
    const f = setup(); f.envFile("providers/other.env", { ...profile, HINDSIGHT_API_LLM_MODEL: "other-model" });
    f.run(pick("other"));
    expect(f.apply().notifications.at(-1)?.level).toBe("info");
    expect(f.management()!.active.provider).toBe("other");
});

test("empty profile directory reports a setup error rather than opening an empty dialog", () => {
    const f = setup(); fs.unlinkSync(path.join(f.root, "providers/primary.env"));
    const result = f.run(pick());
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(result.dialogs).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.root, ".selected-provider"), "utf8")).toBe("primary\n");
    expect(f.state().calls).toEqual([]);
});
