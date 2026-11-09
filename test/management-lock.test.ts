import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const WORKERS = 8, UPDATES = 100;
const worker = `import fs from "node:fs";
Bun.plugin({ name: "fixture-omp", setup(build) {
    build.module("@oh-my-pi/pi-coding-agent", () => ({ exports: { getAgentDir: () => import.meta.dir }, loader: "object" }));
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: { lookup: () => undefined, register: definition => ({ get: () => definition.default }) }, loader: "object" }));
    build.module("@oh-my-pi/pi-natives/vcs", () => ({ exports: { repo: () => undefined }, loader: "object" }));
} });
// Imported after the plugin registers the OMP host modules; a static import would load first.
const { updateState } = await import("./src/management-state.ts");
for (let i = 0; i < ${UPDATES}; i++) {
    await updateState(state => {
        // Two holders at once fail here: the marker exists only inside an update.
        fs.writeFileSync(import.meta.dir + "/inside", "", { flag: "wx" });
        const until = Date.now() + 2; while (Date.now() < until);
        fs.rmSync(import.meta.dir + "/inside");
        return { ...state, counter: (state.counter ?? 0) + 1 };
    });
}`;

test("processes reclaiming the same crashed holder's lock never update the state at once", async () => {
    const f = fixture(); owned.push(f);
    f.manage({ counter: 0 });
    fs.writeFileSync(path.join(f.root, "worker.ts"), worker);
    const lock = path.join(f.root, ".local-management.lock");
    const workers = Array.from({ length: WORKERS }, () => Bun.spawn([process.execPath, "--no-env-file", path.join(f.root, "worker.ts")], { cwd: f.root, stdout: "pipe", stderr: "pipe" }));
    let running = true;
    const exited = Promise.all(workers.map(async proc => ({ code: await proc.exited, stderr: await new Response(proc.stderr).text() }))).finally(() => { running = false; });
    // Whenever the lock is free, a process takes it and dies holding it, so the workers keep racing to reclaim it.
    while (running) {
        try { fs.writeFileSync(lock, "999999999", { flag: "wx" }); } catch { /* held */ }
        await Bun.sleep(1);
    }
    const results = await exited;
    expect(results.filter(result => result.code !== 0)).toEqual([]);
    expect(f.management()!.counter).toBe(WORKERS * UPDATES);
}, 60_000);
