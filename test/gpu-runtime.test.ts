import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { discoverUpdate, fixture, imageId, indexDigest, infrastructure, menu, nativeEnv, profile, update, type DockerState, type Fixture } from "./fixtures";

const owned: Fixture[] = [];
function setup() { const f = fixture(); owned.push(f); return f; }
afterEach(() => { for (const f of owned.splice(0)) f.cleanup(); });

const base = "fixture/image@" + indexDigest;
const competitor = { id: "competitor", pid: process.pid, kind: "apply", startedAt: "2026-11-09T00:00:00.000Z" };
const calls = (f: Fixture, name: string) => f.state().calls.filter(call => call[0] === name);
const launches = (f: Fixture) => f.state().calls.filter(call => call[0] === "run" && call[1] === "-d").length;
const validations = (f: Fixture) => f.state().calls.filter(call => call[0] === "run" && call[1] === "--rm").length;
const derivatives = (f: Fixture) => Object.keys(f.state().images).filter(id => f.state().images[id].labels?.["io.github.razunter.hindsight-omp.derivative"] === "cuda");
const confirmations = (result: { dialogs: { message?: string }[] }) => result.dialogs.filter(dialog => dialog.message !== undefined);
const host = (f: Fixture, patch: Partial<DockerState>) => f.setState({ ...f.state(), ...patch });
const chooseGpu = (f: Fixture, step: Record<string, unknown> = {}, overrides?: Record<string, string>) =>
    f.run([{ startup: false, command: true, choices: [menu.mode, "GPU"], confirm: true, ...step }], overrides);
const status = (f: Fixture) => f.run([{ startup: false, command: true, choices: [menu.status] }]).notifications.at(-1)!.message;

/** An approved CPU runtime on a host whose Docker can run CUDA. */
function cpuOnGpuHost(patch: Partial<DockerState> = {}) {
    const f = setup(); f.apply();
    host(f, { gpu: "cuda", ...patch });
    return { f, running: f.container()!, active: f.management()!.active };
}
/** A healthy GPU runtime built from the cached upstream image. */
function gpuRuntime() {
    const { f } = cpuOnGpuHost();
    expect(chooseGpu(f).notifications.at(-1)?.level).toBe("info");
    return { f, active: f.management()!.active };
}

test("GPU is offered but never chosen implicitly, and CPU works on a host without CUDA", () => {
    const f = setup();
    const result = f.run([{ startup: false, command: true, choices: [menu.mode, "CPU"], confirm: true }]);
    expect(result.dialogs[1].options).toEqual(["Off", "CPU", "GPU"]);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.management()).toMatchObject({ mode: "cpu", active: { mode: "cpu" } });
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.container()!.gpus).toBeUndefined();
    expect(calls(f, "build")).toEqual([]);
    expect(validations(f)).toBe(0);
});

test("choosing GPU builds a CUDA derivative of the approved base and cuts over only after CUDA inference", () => {
    const { f, running } = cpuOnGpuHost();
    const before = f.state().calls.length;
    const result = chooseGpu(f);
    expect(confirmations(result)).toHaveLength(1);
    expect(confirmations(result)[0].message).toContain(base);
    expect(confirmations(result)[0].message).not.toMatch(/migrate/);
    expect(result.notifications.at(-1)?.level).toBe("info");

    const active = f.management()!.active;
    expect(active).toMatchObject({ mode: "gpu", upstream: { reference: infrastructure.HINDSIGHT_IMAGE, digests: [indexDigest] } });
    expect(derivatives(f)).toEqual([active.imageId]);
    expect(f.state().images[active.imageId]).toEqual({
        tags: ["hindsight-omp-cuda:" + "a".repeat(12)],
        labels: { "io.github.razunter.hindsight-omp.installation": f.management()!.installationId, "io.github.razunter.hindsight-omp.derivative": "cuda", "io.github.razunter.hindsight-omp.base": base },
    });
    expect(f.management()!.owned).toEqual([expect.objectContaining({ imageId: active.imageId, kind: "derivative", base })]);
    expect(f.container()).toMatchObject({ image: active.imageId, running: true, gpus: true, mounts: running.mounts, portBindings: running.portBindings, shmSize: running.shmSize });
    expect(nativeEnv(f.container())).toEqual(nativeEnv(running));
    expect(f.state().data).toBe("preserved-data");
    expect(f.state().images[imageId].tags).toEqual([infrastructure.HINDSIGHT_IMAGE]);

    const order = f.state().calls.slice(before).map(call => call.slice(0, 2).join(" "));
    expect(order.indexOf("build --build-arg")).toBeLessThan(order.indexOf("run --rm"));
    expect(order.indexOf("run --rm")).toBeLessThan(order.indexOf("stop --time"));
    const probe = f.state().calls.find(call => call[0] === "run" && call[1] === "--rm")!;
    expect(probe).toContain("--env-file");
    expect(probe.filter(arg => arg === "-v" || arg === "-p")).toEqual([]);
    expect(probe.slice(-2)).toEqual(["embeddings", "reranker"]);
    expect(f.state().buildContext).toEqual({ files: ["Dockerfile"], buildArgs: ["BASE=" + base] });
    expect(JSON.stringify(f.state().calls)).not.toContain(profile.HINDSIGHT_API_LLM_API_KEY);
    expect(status(f)).toContain(active.imageId.slice(7, 19));

    f.run([{ startup: false, command: true, choices: [menu.check] }]);
    expect(f.management()!.check).toMatchObject({ outcome: "current" });
});

test("restarts and later approvals reuse the owned derivative without rebuilding", () => {
    const { f, active } = gpuRuntime();
    const stopped = f.state(); stopped.containers["fixture-hindsight"].running = false; f.setState(stopped);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: active.imageId, running: true, gpus: true });

    const missing = f.state(); delete missing.containers["fixture-hindsight"]; f.setState(missing);
    expect(f.run().notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: active.imageId, running: true, gpus: true });

    expect(f.run([{ startup: false, command: true, choices: [menu.mode, "CPU"], confirm: true }]).notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: imageId, running: true });
    expect(f.container()!.gpus).toBeUndefined();
    const again = chooseGpu(f);
    expect(confirmations(again)[0].message).toContain(active.imageId.slice(7, 19));
    expect(again.notifications.at(-1)?.level).toBe("info");
    expect(f.container()).toMatchObject({ image: active.imageId, running: true, gpus: true });
    expect(calls(f, "build")).toHaveLength(1);
    expect(f.management()!.active).toMatchObject({ mode: "gpu", imageId: active.imageId });
});

test("an approved update rebuilds the CUDA image from the new upstream base", () => {
    const { f, active } = gpuRuntime();
    discoverUpdate(f);
    expect(f.management()!.check).toMatchObject({ outcome: "available", available: { digest: update.platform } });
    const result = f.run([{ startup: false, command: true, choices: [menu.update], confirm: true }]);
    expect(confirmations(result)[0].message).toContain(update.pull);
    expect(confirmations(result)[0].message).toMatch(/migrate/);
    expect(result.notifications.at(-1)?.level).toBe("info");
    expect(f.state().buildContext!.buildArgs).toEqual(["BASE=" + update.pull]);
    const rebuilt = f.management()!.active;
    expect(rebuilt).toMatchObject({ mode: "gpu", upstream: { reference: infrastructure.HINDSIGHT_IMAGE, digests: [update.platform, update.index] } });
    expect(rebuilt.imageId).not.toBe(active.imageId);
    expect(f.state().images[rebuilt.imageId].labels!["io.github.razunter.hindsight-omp.base"]).toBe(update.pull);
    expect(f.container()).toMatchObject({ image: rebuilt.imageId, running: true, gpus: true });
    expect(f.management()!.check).toMatchObject({ outcome: "current" });
    expect(f.state().data).toBe("preserved-data");
});

test.each([
    ["a CPU-only Docker host", {}],
    ["a GPU host whose image cannot use CUDA", { gpu: "no-cuda" as const }],
    ["a GPU host whose models fail inference, such as a missing Triton compiler", { gpu: "cuda" as const, inferenceFails: ["validation" as const] }],
])("%s fails GPU validation before cutover and never falls back to CPU", (_name, patch) => {
    const f = setup(); f.apply();
    const running = f.container(); const active = f.management()!.active;
    host(f, patch);
    expect(chooseGpu(f).notifications.at(-1)?.level).toBe("error");
    expect(launches(f)).toBe(1);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ mode: "gpu", active, failure: { mode: "gpu", stage: "validate" } });
    expect(status(f)).toContain(f.management()!.failure.message);
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(calls(f, "build")).toHaveLength(1);
    expect(f.container()).toEqual(running);
});

test.each([
    ["an incompatible dependency", { buildFails: true }],
    ["an unavailable base image", { dropBase: true }],
])("a CUDA build failing on %s keeps the service and exposes no build output", (_name, patch) => {
    const { f, running, active } = cpuOnGpuHost(patch.buildFails ? { buildFails: true } : {});
    if (patch.dropBase) { const state = f.state(); state.images[imageId].digests = []; f.setState(state); }
    const result = chooseGpu(f);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(validations(f)).toBe(0);
    expect(launches(f)).toBe(1);
    expect(f.container()).toEqual(running);
    expect(derivatives(f)).toEqual([]);
    expect(f.management()).toMatchObject({ mode: "gpu", active, failure: { mode: "gpu", stage: "prepare" } });
    expect(f.management()!.owned).toBeUndefined();
    const log = fs.readFileSync(path.join(f.root, "hindsight.log"), "utf8");
    for (const text of [JSON.stringify(result), status(f), log]) {
        expect(text).not.toContain("synthetic-registry-secret");
        expect(text).not.toContain("fixture-package");
    }
});

test.each([
    ["remote providers", { HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai", HINDSIGHT_API_RERANKER_PROVIDER: "cohere" }],
    ["local models forced to CPU", { HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU: "true", HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU: "true" }],
])("GPU with %s is refused before approval and touches no Docker", (_name, models) => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, ...models });
    host(f, { gpu: "cuda" });
    const result = chooseGpu(f);
    expect(confirmations(result)).toEqual([]);
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(f.state().calls).toEqual([]);
});

test("a GPU-only local reranker is verified alone, and the owner's provider settings are kept", () => {
    const f = setup();
    f.envFile(".env", { ...infrastructure, HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai" });
    host(f, { gpu: "cuda" });
    expect(chooseGpu(f).notifications.at(-1)?.level).toBe("info");
    expect(nativeEnv(f.container()).HINDSIGHT_API_EMBEDDINGS_PROVIDER).toBe("openai");
    expect(f.container()).toMatchObject({ gpus: true, running: true });
    const check = calls(f, "exec").at(-1)!;
    expect(check.slice(0, 2)).toEqual(["exec", "fixture-hindsight"]);
    expect(check.slice(-1)).toEqual(["reranker"]);
    expect(JSON.stringify(calls(f, "exec"))).not.toContain(profile.HINDSIGHT_API_LLM_API_KEY);
});

test("a container without the approved GPU request is not adopted on startup", () => {
    const { f } = gpuRuntime();
    const state = f.state(); delete state.containers["fixture-hindsight"].gpus; state.containers["fixture-hindsight"].running = false; f.setState(state);
    const before = f.state().calls.length;
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
    expect(f.state().calls.slice(before).filter(call => ["start", "run", "build", "stop"].includes(call[0]))).toEqual([]);
    expect(f.container()!.running).toBe(false);
});

test.each([
    ["models still on CPU", { modelDevice: "cpu" }, "ran on cpu, not CUDA"],
    ["models that initialized on CUDA but fail inference", { inferenceFails: ["service" as const] }, "failed a CUDA inference check"],
])("a visible GPU with %s fails readiness and preserves the previous container", (_name, patch, reason) => {
    const { f, active } = cpuOnGpuHost(patch);
    const result = chooseGpu(f, {}, { HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS: "1" });
    expect(result.notifications.at(-1)?.level).toBe("error");
    expect(result.notifications.at(-1)?.message).toContain(reason);
    const containers = f.state().containers;
    const previous = Object.keys(containers).find(name => name.startsWith("fixture-hindsight-previous-"))!;
    expect(result.notifications.at(-1)?.message).toContain(previous);
    expect(containers[previous]).toMatchObject({ image: imageId, running: false });
    expect(containers["fixture-hindsight"]).toMatchObject({ gpus: true, running: false });
    expect(calls(f, "image").filter(call => call[1] === "rm")).toEqual([]);
    expect(derivatives(f)).toHaveLength(1);
    expect(f.management()).toMatchObject({ mode: "gpu", active, failure: { mode: "gpu", stage: "readiness" } });
    expect(f.state().data).toBe("preserved-data");
});

test("declining a GPU build builds and restarts nothing and keeps GPU visibly requested", () => {
    const { f, running, active } = cpuOnGpuHost();
    const result = chooseGpu(f, { confirm: false });
    expect(confirmations(result)[0].message).toContain(base);
    expect(calls(f, "build")).toEqual([]);
    expect(launches(f)).toBe(1);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ mode: "gpu", active });
    expect(f.run().notifications.at(-1)?.level).toBe("warning");
});

test("Off chosen while the build confirmation is open builds nothing", () => {
    const { f, running, active } = cpuOnGpuHost();
    const result = chooseGpu(f, { afterConfirm: { mode: "off" } });
    expect(result.notifications.at(-1)?.level).toBe("warning");
    expect(calls(f, "build")).toEqual([]);
    expect(validations(f)).toBe(0);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ mode: "off", active, failure: { stage: "validate" } });
});

test.each([
    ["Off", { mode: "off" }],
    ["a competing process", { operation: competitor }],
])("%s during the build prevents the cutover and keeps the service", (_name, management) => {
    const { f, running, active } = cpuOnGpuHost();
    host(f, { mutate: { when: "build", management }, waitForHandler: true });
    expect(chooseGpu(f).notifications.at(-1)?.level).toBe("warning");
    expect(launches(f)).toBe(1);
    expect(f.container()).toEqual(running);
    expect(f.management()).toMatchObject({ ...management, active, failure: { stage: "validate" } });
});

test("a slow, verbose build runs after the handler returns", () => {
    const { f } = cpuOnGpuHost({ waitForHandler: true, outputBytes: 2 * 1024 * 1024, buildDelayMs: 1_000 });
    const result = chooseGpu(f);
    expect(f.state().released).toBe(true);
    expect(result.notifications.map(n => n.level)).toEqual(["info", "info"]);
    expect(f.container()).toMatchObject({ gpus: true, running: true });
});
