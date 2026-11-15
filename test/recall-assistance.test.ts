import { expect, test } from "bun:test";
import path from "node:path";

const driver = `
const input = JSON.parse(process.env.FOOTER_CASE);
const values = { "memory.backend": "hindsight", "hindsightOmp.retrievalFooterEnabled": true, ...input.values };
if (input.nonfinite) values["hindsightOmp.recallNudgeEveryToolCalls"] = Number(input.nonfinite);
const definitions = new Map();
Bun.plugin({ name: "footer-host", setup(build) {
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: {
        lookup: id => ({ get: () => values[id] }),
        register: definition => {
            definitions.set(definition.id, definition);
            return { get: () => values[definition.id] ?? definition.default };
        },
    }, loader: "object" }));
} });
// Isolate host-module loading so Bun plugins cannot leak into other suites.
const { registerRecallAssistance } = await import(process.env.FOOTER_MODULE);
if (input.validation) {
    const definition = definitions.get("hindsightOmp.recallNudgeEveryToolCalls");
    console.log(JSON.stringify(input.validation.map(step => {
        try {
            definition.validate(step.raw);
            return "accepted";
        } catch (error) {
            return error.message;
        }
    })));
    process.exit(0);
}
const hooks = new Map();
let active = input.active ?? ["recall", "reflect", "hindsight_evidence", "read", "write"];
const pi = {
    pi: { settings: {} },
    on: (name, handler) => hooks.set(name, handler),
    getActiveTools: () => [...active],
    getAllTools: () => (input.catalog ?? active).map(name => ({ name })),
};
registerRecallAssistance(pi);
const childHooks = new Map();
if (input.child) registerRecallAssistance({ ...pi, on: (name, handler) => childHooks.set(name, handler) });
let messages = input.history ?? [];
const diagnostics = [];
const ctx = {
    cwd: "/fixture/project", hasUI: false, agent: { kind: "main" },
    model: { provider: "openai-codex" },
    sessionManager: { getBranch: () => input.branch ?? messages.map(message => ({ type: "message", message })) },
};
pi.logger = { warn: message => diagnostics.push(message) };
let previous;
const results = [];
for (const step of input.steps) {
    Object.assign(values, step.values);
    if (step.active) active = step.active;
    if (step.kind) ctx.agent.kind = step.kind;
    if (step.hasUI !== undefined) ctx.hasUI = step.hasUI;
    if (step.cwd) ctx.cwd = step.cwd;
    if (input.events) {
        const event = step.event;
        if (step.messages) messages = step.messages;
        if (step.accept) messages.push({ role: "user", attribution: "user", timestamp: results.length + 1, content: "work", ...step.accept });
        const payload = event === "context" ? { messages }
            : event === "before_agent_start" ? { systemPrompt: "base", prompt: "work", images: [] }
            : { toolName: "bash", toolCallId: String(results.length), input: {}, content: [{ type: "text", text: "work result" }], isError: false, ...step.payload };
        const result = await (step.child ? childHooks : hooks).get(event)?.(payload, ctx);
        results.push({ result: result ?? null, diagnostics: [...diagnostics] });
        continue;
    }
    const systemPrompt = step.reuse ? previous : step.systemPrompt;
    const result = await hooks.get("before_agent_start")({ systemPrompt, prompt: step.prompt ?? "ordinary work", images: [] }, ctx);
    if (result && Object.keys(result).some(key => key !== "systemPrompt")) throw new Error("Footer must only prepare system context");
    previous = result?.systemPrompt ?? systemPrompt;
    results.push(previous);
}
console.log(JSON.stringify(results));
`;
function run(input: Record<string, unknown>): (string | string[])[] {
    const result = Bun.spawnSync([process.execPath, "--eval", driver], {
        env: { ...process.env, FOOTER_CASE: JSON.stringify(input), FOOTER_MODULE: path.resolve(import.meta.dir, "../src/recall-assistance.ts") },
        timeout: 10_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
}
const open = "<hindsight-omp-retrieval>";
const close = "</hindsight-omp-retrieval>";
const text = (prompt: string | string[]) => typeof prompt === "string" ? prompt : prompt.join("\n");

test("settings reload accepts an omitted cadence and valid configured intervals", () => {
    expect(run({ validation: [{}, { raw: 0 }, { raw: 20 }] })).toEqual(["accepted", "accepted", "accepted"]);
});

test.each([null, -1, 0.5, 9007199254740992, "3", true])("settings reload rejects malformed configured cadence %j", raw => {
    expect(run({ validation: [{ raw }] })).toEqual(["expected a nonnegative safe integer"]);
});

test("string preparation is stable across changed tasks, retries and discarded attempts; disablement preserves chained context", () => {
    const base = "native guidance\n\n<other-extension>keep me</other-extension>";
    const results = run({ steps: [
        { systemPrompt: base, prompt: "first task" },
        { reuse: true, prompt: "different task" },
        { systemPrompt: base, prompt: "retry after cancelled preparation" },
        { reuse: true, values: { "hindsightOmp.retrievalFooterEnabled": false } },
    ] });
    expect(results[0]).toContain(open);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(text(results[0]).split(open)).toHaveLength(2);
    expect(results[3]).toBe(base);
});

test("array preparation keeps unrelated blocks and removes only owned guidance", () => {
    const base = ["native guidance", "", "chained guidance"];
    const results = run({ steps: [{ systemPrompt: base }, { reuse: true }, { reuse: true, values: { "hindsightOmp.retrievalFooterEnabled": false } }] });
    expect(results[0]).toEqual([...base, expect.stringContaining(open)]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(base);
});

test.each(["sub", "advisor"])("%s cannot inherit main footer, even at depth zero", kind => {
    const results = run({ steps: [{ systemPrompt: "base" }, { reuse: true, kind }] });
    expect(results[0]).toContain(open);
    expect(results[1]).toBe("base");
});

test.each(["off", "other"])("backend %s removes main guidance at the next preparation", backend => {
    const results = run({ steps: [{ systemPrompt: "base" }, { reuse: true, values: { "memory.backend": backend } }] });
    expect(results[0]).toContain(open);
    expect(results[1]).toBe("base");
});

test("catalog-only retrieval tools do not override the enabled tool restriction", () => {
    const results = run({ catalog: ["recall", "reflect", "hindsight_evidence", "read", "write"], steps: [
        { systemPrompt: "base" }, { reuse: true, active: ["read", "write", "bash"] },
    ] });
    expect(results[0]).toContain(open);
    expect(results[1]).toBe("base");
});

test("guidance changes with permitted routes without stacking or advertising removed routes", () => {
    const results = run({ active: ["recall", "read", "write"], steps: [
        { systemPrompt: "base" }, { reuse: true, active: ["hindsight_evidence", "read", "write"] },
        { reuse: true, active: ["reflect"] },
    ] });
    expect(results[0]).toContain("recall");
    expect(results[0]).not.toContain("reflect");
    expect(results[0]).not.toContain("hindsight_evidence");
    expect(results[1]).toContain("hindsight_evidence");
    expect(results[1]).not.toContain("recall");
    expect(results[2]).toContain("reflect");
    expect(results[2]).not.toContain("hindsight_evidence");
    for (const result of results) {
        expect(text(result).split(open)).toHaveLength(2);
        expect(text(result).split(close)).toHaveLength(2);
        expect(text(result).startsWith("base")).toBe(true);
    }
});

test("enabled eval guidance uses retrieval bridges and falls back to device discovery when eval is disabled", () => {
    const results = run({ active: ["eval", "read", "write", "recall"], steps: [
        { systemPrompt: "base" }, { reuse: true, active: ["read", "write", "recall"] },
    ] });
    expect(results[0]).toContain("tool.recall");
    expect(results[0]).not.toContain("xd://recall");
    expect(results[1]).toContain("xd://recall");
    expect(results[1]).not.toContain("tool.recall");
});

test("terminal availability does not change eligible main guidance", () => {
    const results = run({ steps: [{ systemPrompt: "base", hasUI: false }, { systemPrompt: "base", hasUI: true }] });
    expect(results[0]).toContain(open);
    expect(results[1]).toBe(results[0]);
});

const qualityOpen = "<hindsight-omp-memory-quality>";
const qualityClose = "</hindsight-omp-memory-quality>";

test.each(["string", "array"])("curated lesson guidance stays independent and idempotent for %s prompts", shape => {
    const base = shape === "string" ? "native guidance\n\n<other-extension>keep</other-extension>" : ["native guidance", "", "<other-extension>keep</other-extension>"];
    const results = run({
        active: ["learn", "retain", "read", "write"],
        catalog: ["learn", "retain", "read", "write"],
        values: { "hindsightOmp.retrievalFooterEnabled": false, "hindsightOmp.recallNudgeEveryToolCalls": 0 },
        steps: [
            { systemPrompt: base }, { reuse: true },
            { reuse: true, active: ["learn", "retain", "eval"] },
            { reuse: true, active: ["learn", "eval"] },
            { reuse: true, active: ["retain", "eval"] },
            { reuse: true, active: ["retain"] },
            { reuse: true, active: ["read", "write", "eval"] },
            { reuse: true, active: ["read", "write"] },
        ],
    });
    expect(text(results[0]).split(qualityOpen)).toHaveLength(2);
    expect(text(results[0]).split(qualityClose)).toHaveLength(2);
    expect(text(results[0])).not.toContain(open);
    expect(text(results[0])).toContain("`learn`");
    expect(text(results[0])).not.toContain("`retain`");
    expect(results[1]).toEqual(results[0]);
    expect(text(results[2])).toContain("`learn`");
    expect(text(results[2])).not.toContain("tool.learn");
    expect(text(results[3])).toContain("`learn`");
    expect(text(results[3])).not.toContain("tool.learn");
    expect(text(results[4])).toContain("tool.retain");
    expect(text(results[4])).not.toContain("`learn`");
    expect(text(results[5])).toContain("`retain`");
    expect(text(results[5])).not.toContain("tool.retain");
    for (const result of results.slice(0, -2)) expect(text(result).split(qualityOpen)).toHaveLength(2);
    expect(results[6]).toEqual(base);
    expect(results[7]).toEqual(base);
});

test.each([
    { kind: "sub" }, { kind: "advisor" },
    { values: { "memory.backend": "off" } }, { values: { "memory.backend": "other" } },
])("curated lesson guidance is removed outside an eligible main Hindsight session %j", restriction => {
    const results = run({ active: ["learn"], steps: [
        { systemPrompt: ["native guidance"] }, { reuse: true, ...restriction },
    ] });
    expect(text(results[0])).toContain(qualityOpen);
    expect(results[1]).toEqual(["native guidance"]);
});

test.each([[true, 0], [false, 0], [true, 3], [false, 3]] as const)("curated lesson guidance coexists with footer %j and cadence %j", (footer, cadence) => {
    const results = run({
        active: ["learn", "recall"],
        values: { "hindsightOmp.retrievalFooterEnabled": footer, "hindsightOmp.recallNudgeEveryToolCalls": cadence },
        steps: [{ systemPrompt: "native guidance" }, { reuse: true }],
    });
    expect(text(results[0]).includes(open)).toBe(footer);
    expect(text(results[0])).toContain(qualityOpen);
    expect(results[1]).toEqual(results[0]);
});

const quality = (prompt: string | string[]) => text(prompt).split(qualityOpen + "\n")[1]?.split("\n" + qualityClose)[0];

test("observation guidance names observe beside lessons and holds the block alone without a lesson tool", () => {
    const results = run({ active: ["learn", "observe"], steps: [
        { systemPrompt: "native guidance" }, { reuse: true },
        { reuse: true, active: ["observe"] },
        { reuse: true, active: ["learn"] },
    ] });
    expect(quality(results[0])).toContain("Curated lessons:");
    expect(quality(results[0])).toContain("record an observation with `observe`");
    expect(results[1]).toEqual(results[0]);
    expect(quality(results[2])).toMatch(/^Observations: [^\n]*`observe`[^\n]*$/);
    expect(quality(results[3])).toContain("Curated lessons:");
    expect(quality(results[3])).not.toContain("`observe`");
});

test.each([
    { kind: "sub" }, { values: { "memory.backend": "other" } }, { active: ["read"] },
])("observation guidance is removed outside an eligible main Hindsight session with observe %j", restriction => {
    const results = run({ active: ["observe"], steps: [{ systemPrompt: "native guidance" }, { reuse: true, ...restriction }] });
    expect(quality(results[0])).toContain("`observe`");
    expect(results[1]).toEqual("native guidance");
});

interface HookObservation {
    result: { messages?: { role: string; customType?: string; content: string }[]; additionalContext?: string; systemPrompt?: string } | null;
    diagnostics: string[];
}
function events(steps: Record<string, unknown>[], values: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return run({ events: true, steps, values: { "hindsightOmp.recallNudgeEveryToolCalls": 3, ...values }, ...extra }) as unknown as HookObservation[];
}
const work = (toolName = "bash", input = {}, isError = false) => ({ event: "tool_result", payload: { toolName, input, isError } });
const prepare = { event: "before_agent_start" };
const accepted = (accept = {}) => ({ event: "context", accept });
const hasNudge = (entry: HookObservation) => entry.result?.messages?.some(message => message.customType === "hindsight-omp-nudge") ?? false;
const due = (entry: HookObservation) => entry.result?.additionalContext !== undefined;

test.each([true, false])("footer %s is independent of positive and disabled cadence", footer => {
    for (const interval of [0, 3]) {
        const result = events([prepare, accepted(), work(), work(), work()], {
            "hindsightOmp.retrievalFooterEnabled": footer, "hindsightOmp.recallNudgeEveryToolCalls": interval,
        });
        expect(result[0].result?.systemPrompt?.includes(open)).toBe(footer);
        expect(hasNudge(result[1])).toBe(interval > 0);
        expect(due(result[4])).toBe(interval > 0);
    }
});

test("accepted genuine work gets one tail reminder; retries, cancelled preparations and synthetic companions do not", () => {
    const result = events([
        prepare, prepare, accepted(), { event: "context" },
        prepare, accepted({ attribution: "agent" }), prepare, accepted({ synthetic: true }),
        prepare, accepted(), prepare, accepted(),
    ]);
    expect(result.map(hasNudge)).toEqual([false, false, true, false, false, false, false, false, false, true, false, true]);
    expect(result[2].result?.messages?.[0].role).toBe("user");
});

test("restored user history and preparation cancellation cannot replay a prompt reminder", () => {
    const result = events([{ event: "session_start" }, prepare, { event: "context" }, prepare, accepted()],
        {}, { history: [{ role: "user", attribution: "user", timestamp: 1, content: "old work" }] });
    expect(hasNudge(result[2])).toBe(false);
    expect(hasNudge(result[4])).toBe(true);
});

test("N-1 versus N and repeated thresholds work without another prompt; outer nested wrappers only flush", () => {
    const result = events([work(), work(), work(), work("eval"), { event: "context" }, work(), work(), work(), work("write", { path: "xd://eval" })]);
    expect(result.map(due)).toEqual([false, false, true, true, false, false, false, true, true]);
    expect(result[2].result?.additionalContext).toBe(result[3].result?.additionalContext);
    expect(result[7].result?.additionalContext).toBe(result[8].result?.additionalContext);
});

test.each(["read", "grep", "glob", "web_search", "bash", "edit", "write", "ast_edit", "lsp",
    "ffgrep", "fffind", "semantic_query", "mcp__context7_query_docs", "notebook", "browser", "custom_work",
])("%s successful leaf work counts without a work allowlist", tool => {
    expect(events([work(tool), work(tool), work(tool)]).map(due)).toEqual([false, false, true]);
});

test("errors, internal routes, wrappers, control and memory traffic do not advance work", () => {
    const excluded = [
        work("bash", {}, true), work("read", { path: "skill://research" }), work("write", { path: "xd://recall" }),
        work("read", { path: "agent://child" }), work("eval"), work("todo"), work("wait"), work("ask"), work("task"),
        work("multi_tool_use"), work("multi_tool_use.parallel"), work("parallel"), work("context_notes"), work("new_context"),
        work("manage_skill"), work("observer_resolve"), work("observer_check"), work("observer_review"), work("observer_evaluation"),
        work("completion"), work("judge"), work("judge_batch"), work("agent"), work("workpool"), work("observe"),
        work("retain"), work("learn"), work("hindsight_evidence", { action: "source_read" }),
    ];
    const result = events([work(), ...excluded, work("read", { path: "https://example.com" }), work("write", { path: "file.ts" })]);
    expect(result.slice(0, -1).some(due)).toBe(false);
    expect(due(result.at(-1)!)).toBe(true);
});

test("device leaf searches count once; schema access and outer device/eval receipts do not count", () => {
    const result = events([
        work("read", { path: "xd://ffgrep" }), work("ffgrep"), work("write", { path: "xd://ffgrep" }),
        work("fffind"), work("eval"), work("ffgrep"), work("write", { path: "xd://ffgrep" }),
        { event: "context" }, work("semantic_query"), work("mcp__context7_query_docs"), work("custom_work"),
    ]);
    expect(result.map(due)).toEqual([false, false, false, false, false, true, true, false, false, false, true]);
});

test("failed non-default work and excluded empty wrappers do not masquerade as leaf progress", () => {
    const result = events([work("ffgrep"), work("custom_work", {}, true), work("eval"), work("multi_tool_use"),
        work("fffind"), work("custom_work")]);
    expect(result.map(due)).toEqual([false, false, false, false, false, true]);
});

test.each(["recall", "reflect", "hindsight_evidence"])("%s successful empty search resets work, failed search does not", tool => {
    const input = tool === "hindsight_evidence" ? { action: "source_search" } : {};
    const success = events([work(), work(), work(tool, input), work(), work(), work()]);
    expect(success.map(due)).toEqual([false, false, false, false, false, true]);
    const failed = events([work(), work(), work(tool, input, true), work()]);
    expect(failed.map(due)).toEqual([false, false, false, true]);
});

test("page searches reset but evidence reads do not", () => {
    expect(events([work(), work(), work("hindsight_evidence", { action: "page_search" }), work(), work(), work()]).map(due))
        .toEqual([false, false, false, false, false, true]);
    expect(events([work(), work(), work("hindsight_evidence", { action: "page_read" }), work()]).map(due))
        .toEqual([false, false, false, true]);
});

test.each(["session_start", "session_switch", "session_branch", "session_tree", "session_compact"])("%s resets work without replay debt", event => {
    expect(events([work(), work(), { event }, work(), work(), work()]).map(due)).toEqual([false, false, false, false, false, true]);
});

test.each([
    { values: { "hindsightOmp.recallNudgeEveryToolCalls": 4 } },
    { values: { "hindsight.bankId": "another-bank" } },
    { cwd: "/fixture/other" },
    { kind: "sub" },
    { values: { "memory.backend": "off" } },
    { active: ["bash"] },
])("configuration, scope and eligibility boundaries drop accumulated work: %j", change => {
    const result = events([work(), work(), { event: "context", ...change }, work(),
        { event: "context", kind: "main", active: ["recall", "bash"], values: { "memory.backend": "hindsight", "hindsightOmp.recallNudgeEveryToolCalls": 3 } },
        work(), work(), work()]);
    expect(result.slice(0, -1).some(due)).toBe(false);
    expect(due(result.at(-1)!)).toBe(true);
});

test.each([-1, 0.5, 9007199254740992, "3", true])("invalid effective cadence %j disables nudges but preserves footer and recovers", value => {
    const result = events([{ event: "session_start" }, prepare, accepted(), work(), work(), work(),
        { event: "context", values: { "hindsightOmp.recallNudgeEveryToolCalls": 3 } }, work(), work(), work()],
        { "hindsightOmp.recallNudgeEveryToolCalls": value });
    expect(result[0].diagnostics.some(message => message.includes("hindsightOmp.recallNudgeEveryToolCalls"))).toBe(true);
    expect(result[1].result?.systemPrompt).toContain(open);
    expect(hasNudge(result[2])).toBe(false);
    expect(result.slice(0, 9).some(due)).toBe(false);
    expect(due(result[9])).toBe(true);
});

test("compacted history does not turn an agent-origin prompt into fresh user work", () => {
    const old = { role: "user", attribution: "user", timestamp: 1, content: "old" };
    const latest = { ...old, timestamp: 2 };
    const result = events([{ event: "session_start" }, prepare, {
        event: "context", messages: [latest], accept: { attribution: "agent" },
    }], {}, { history: [old, latest] });
    expect(hasNudge(result[2])).toBe(false);
});

test("new accepted user work resets cadence, even when prompt timestamps coincide", () => {
    const result = events([prepare, accepted({ timestamp: 1 }), work(), work(), prepare, accepted({ timestamp: 1 }), work(), work(), work()]);
    expect(hasNudge(result[1])).toBe(true);
    expect(hasNudge(result[5])).toBe(true);
    expect(result.slice(0, -1).some(due)).toBe(false);
    expect(due(result.at(-1)!)).toBe(true);
});

test("bound main and child factories never share pending work", () => {
    const result = events([work(), work(), { ...work(), child: true, kind: "sub" },
        { ...work(), child: true }, { ...work(), child: true }, { ...work(), kind: "main" }], {}, { child: true });
    expect(result.map(due)).toEqual([false, false, false, false, false, true]);
});

test("a batch crossing several thresholds yields identical coalescible context and keeps its remainder", () => {
    const result = events([work(), work(), work(), work(), work(), work(), work(), { event: "context" }, work(), work()]);
    const contexts = result.slice(0, 7).flatMap(entry => entry.result?.additionalContext ? [entry.result.additionalContext] : []);
    expect(contexts).toHaveLength(5);
    expect(new Set(contexts).size).toBe(1);
    expect(due(result[8])).toBe(false);
    expect(due(result[9])).toBe(true);
});

test.each(["Infinity", "-Infinity", "NaN"])("nonfinite %s disables reminders without coercion", nonfinite => {
    const result = events([{ event: "session_start" }, prepare, accepted(), work(), work(), work()], {}, { nonfinite });
    expect(result[0].diagnostics).toHaveLength(1);
    expect(result.slice(2).some(due)).toBe(false);
    expect(hasNudge(result[2])).toBe(false);
    expect(result[1].result?.systemPrompt).toContain(open);
});

test("accepted user-origin skill messages receive reminders without nudging agent companions", () => {
    const result = events([prepare, accepted({ role: "custom", customType: "skill-prompt" }),
        prepare, accepted({ role: "custom", customType: "skill-prompt", attribution: "agent" })]);
    expect(result.map(hasNudge)).toEqual([false, true, false, false]);
});

test("restored custom user entries are not replayed by an agent-only preparation", () => {
    const history = [{ role: "custom", customType: "skill-prompt", attribution: "user", timestamp: 1, content: "old skill" }];
    const result = events([{ event: "session_start" }, prepare, accepted({ attribution: "agent" })], {}, {
        history, branch: [{ type: "custom_message", attribution: "user", timestamp: new Date(1).toISOString() }],
    });
    expect(hasNudge(result[2])).toBe(false);
});
