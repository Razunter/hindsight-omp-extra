import { expect, test } from "bun:test";

// Bun module mocks are process-wide; isolate the native API doubles from other extension tests.
test("registered curation investigates only a current host lead through bounded scoped reads", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/curation.fixture.ts`], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
