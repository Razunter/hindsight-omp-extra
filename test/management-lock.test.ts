import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, fixtureFileLock, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const WORKERS = 8, UPDATES = 100;
const worker = `import fs from "node:fs";
${fixtureFileLock}
Bun.plugin({ name: "fixture-omp", setup(build) {
    build.module("@oh-my-pi/pi-coding-agent", () => ({ exports: { getAgentDir: () => import.meta.dir }, loader: "object" }));
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: { lookup: () => undefined, register: definition => ({ get: () => definition.default }) }, loader: "object" }));
    build.module("@oh-my-pi/pi-natives/vcs", () => ({ exports: { repo: () => undefined }, loader: "object" }));
} });
// Imported after the plugin registers the OMP host modules; a static import would load first.
const { updateState } = await import("./src/management-state.ts");
const mode = process.argv[2];
if (mode === "hold") {
    const lock = tryAcquireFileLock(import.meta.dir + "/.local-management.json");
    if (!lock) throw new Error("Could not hold fixture lock");
    console.log("held");
    await new Promise(() => {});
} else for (let i = 0; i < (mode === "once" ? 1 : ${UPDATES}); i++) {
    await updateState(state => {
        // Two holders at once fail here: the marker exists only inside an update.
        fs.writeFileSync(import.meta.dir + "/inside", "", { flag: "wx" });
        const until = Date.now() + 2; while (Date.now() < until);
        fs.rmSync(import.meta.dir + "/inside");
        return { ...state, counter: (state.counter ?? 0) + 1 };
    });
}`;

function startWorker(f: Fixture, mode?: string) {
    const driver = path.join(f.root, "worker.ts");
    return Bun.spawn([process.execPath, "--no-env-file", driver, ...(mode ? [mode] : [])], {
        cwd: f.root, stdout: "pipe", stderr: "pipe",
    });
}

test("concurrent processes do not lose local management state updates", async () => {
    const f = fixture(); owned.push(f);
    f.manage({ counter: 0 });
    fs.writeFileSync(path.join(f.root, "worker.ts"), worker);
    const workers = Array.from({ length: WORKERS }, () => startWorker(f));
    const results = await Promise.all(workers.map(async proc => ({ code: await proc.exited, stderr: await new Response(proc.stderr).text() })));
    expect(results.filter(result => result.code !== 0)).toEqual([]);
    expect(f.management()!.counter).toBe(WORKERS * UPDATES);
}, 60_000);

test("state updates cannot displace a live lock holder and proceed after it dies", async () => {
    const f = fixture(); owned.push(f);
    f.manage({ counter: 0 });
    fs.writeFileSync(path.join(f.root, "worker.ts"), worker);
    const holder = startWorker(f, "hold");
    const reader = holder.stdout.getReader();
    try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
        const blocked = startWorker(f, "once");
        expect(await blocked.exited).not.toBe(0);
        expect(await new Response(blocked.stderr).text()).toContain("local management state is locked");
        expect(f.management()!.counter).toBe(0);
    } finally {
        holder.kill("SIGKILL");
        await holder.exited;
        reader.releaseLock();
    }
    const next = startWorker(f, "once");
    expect({ code: await next.exited, stderr: await new Response(next.stderr).text() }).toEqual({ code: 0, stderr: "" });
    expect(f.management()!.counter).toBe(1);
}, 15_000);

test("the lock cutover refuses to write while a legacy state lock remains", async () => {
    const f = fixture(); owned.push(f);
    f.manage({ counter: 0 });
    fs.writeFileSync(path.join(f.root, "worker.ts"), worker);
    const legacy = path.join(f.root, ".local-management.lock");
    fs.writeFileSync(legacy, process.pid + "-legacy");
    fs.utimesSync(legacy, 1, 1);

    const blocked = startWorker(f, "once");
    expect(await blocked.exited).not.toBe(0);
    expect(await new Response(blocked.stderr).text()).toContain("legacy local management lock");
    expect(f.management()!.counter).toBe(0);

    fs.unlinkSync(legacy);
    const next = startWorker(f, "once");
    expect({ code: await next.exited, stderr: await new Response(next.stderr).text() }).toEqual({ code: 0, stderr: "" });
    expect(f.management()!.counter).toBe(1);
    // The previous version claims this same path with an exclusive file creation.
    expect(() => fs.writeFileSync(legacy, "old-writer", { flag: "wx" })).toThrow(expect.objectContaining({ code: "EEXIST" }));
});
