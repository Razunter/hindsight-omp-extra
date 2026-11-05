import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, type Fixture } from "./fixtures";
const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });
const oldId = "sha256:" + "1".repeat(64);
const newId = "sha256:" + "2".repeat(64);
const unrelatedId = "sha256:" + "3".repeat(64);

test("updating removes only the superseded unused image, never unrelated artifacts", () => {
    const f = setup(); f.run(); const state = f.state();
    state.images[unrelatedId] = { tags: [], otherContainers: 0 }; state.pullImage = newId; f.setState(state);
    fs.unlinkSync(path.join(f.root, ".last-image-check"));
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.state().container!.image).toBe(newId);
    expect(f.state().images[oldId]).toBeUndefined();
    expect(f.state().images[unrelatedId]).toEqual(state.images[unrelatedId]);
    expect(f.state().data).toBe("preserved-data");
});

test.each(["other-container", "other-tag"])("superseded images with %s ownership are preserved", ownership => {
    const f = setup(); f.run(); const state = f.state(); state.pullImage = newId;
    if (ownership === "other-container") state.images[oldId].otherContainers = 1;
    else state.images[oldId].tags.push("independent/image:keep");
    f.setState(state); fs.unlinkSync(path.join(f.root, ".last-image-check"));
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.state().images[oldId]).toEqual({ tags: ownership === "other-tag" ? ["independent/image:keep"] : [], otherContainers: ownership === "other-container" ? 1 : 0 });
});

test.each(["fresh", "update"])("failed %s startup removes its newly downloaded unused images", mode => {
    const f = setup(); const state = f.state(); if (mode === "fresh") delete state.images[oldId];
    state.images[unrelatedId] = { tags: ["independent/image:keep"], otherContainers: 0 };
    state.pullImage = newId; state.runFails = true; f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().images[newId]).toBeUndefined();
    expect(f.state().images[unrelatedId]).toEqual(state.images[unrelatedId]);
    expect(f.state().container).toBeNull();
    expect(f.state().images[oldId]).toBeUndefined();
});

test("failed startup does not remove an image that existed before the pull", () => {
    const f = setup(); const state = f.state(); state.runFails = true; f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().images[oldId]).toEqual(state.images[oldId]);
});

test("cleanup failure is visible rather than claiming reconciliation succeeded", () => {
    const f = setup(); f.run(); const state = f.state(); state.pullImage = newId; state.imageRemoveFails = true; f.setState(state);
    fs.unlinkSync(path.join(f.root, ".last-image-check"));
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().images[oldId]).toBeDefined();
});

test("a cached replacement image belongs to the operator, not this pull", () => {
    const f = setup(); const state = f.state();
    state.images[newId] = { tags: [], otherContainers: 0 }; state.pullImage = newId; state.runFails = true; f.setState(state);
    expect(f.run().notifications.at(-1)?.level).toBe("error");
    expect(f.state().images[newId]).toEqual({ tags: ["fixture/image:local"], otherContainers: 0 });
});
