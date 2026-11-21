import assert from "node:assert/strict";
import path from "node:path";

const cwd = "/repo/project";
const sessionId = "native-session";
const ref = "b3eb0c4e-2904-4bbf-bfbe-0a3d06f03195";
const text = "Hindsight recall repeats the old Quill test instructions as duplicate facts.";
const settings = {
    backend: "hindsight", hindsightApiUrl: "", hindsightApiToken: "fixture-token", scoping: "per-project-tagged",
    bankId: "bank", bankIdPrefix: "team", recallBudget: "mid", recallMaxTokens: 128, recallMaxQueryChars: 400, recallTimeoutMs: 1500,
};
Bun.plugin({ name: "curation-native-host", setup(build) {
    const module = (id: string, exports: Record<string, unknown>) => build.module(id, () => ({ exports, loader: "object" }));
    module("@oh-my-pi/pi-coding-agent/config/registry", {
        lookup: (id: string) => id === "memory.backend" ? { get: () => settings.backend } : undefined,
    });
    module("@oh-my-pi/pi-coding-agent/hindsight/config", { loadHindsightConfig: () => settings, isHindsightConfigured: () => Boolean(settings.hindsightApiUrl) });
    module("@oh-my-pi/pi-coding-agent/hindsight/bank", {
        computeBankScope: (config: typeof settings, directory: string) => {
            const base = `${config.bankIdPrefix}-${config.bankId}`;
            const project = path.basename(directory);
            if (config.scoping === "per-project-tagged") return { bankId: base, retainTags: [`project:${project}`], recallTags: [`project:${project}`], recallTagsMatch: "any" };
            return { bankId: config.scoping === "per-project" ? `${base}-${project}` : base };
        },
    });
    module("@oh-my-pi/pi-natives/vcs", { repo: () => undefined });
} });
// Install the native host module doubles before loading the registered extension.
const { registerCuration } = await import("../src/curation");

type Entry = Record<string, unknown>;
type Context = typeof ctx;
type ToolResult = { content: { text: string }[]; isError?: boolean };
type Tool = { name: string; execute(id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: Context): Promise<ToolResult> };
type EventHandler = (event: { messages?: Entry[] }, ctx: Context) => unknown;
const tools = new Map<string, Tool>();
const handlers = new Map<string, EventHandler[]>();
let enabled = true;
registerCuration({
    pi: { settings }, arktype() { return {}; },
    on(name: string, handler: EventHandler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    getActiveTools: () => enabled ? ["eval", "hindsight_curate"] : ["eval"],
} as unknown as Parameters<typeof registerCuration>[0]);
const tool = tools.get("hindsight_curate");
assert.ok(tool, "Hindsight extension must register its read-only curation action");

let liveCwd = cwd;
let liveSession = sessionId;
let branch: Entry[] = [];
const nativeForm = async () => { throw new Error("Investigation must not open a confirmation"); };
const ctx = {
    cwd, mode: "tui", hasUI: true, agent: { kind: "main" },
    ui: { formDialog: nativeForm as typeof nativeForm | undefined, custom: nativeForm as typeof nativeForm | undefined },
    sessionManager: { getBranch: () => [...branch], getEntries: () => [...branch], getCwd: () => liveCwd, getSessionId: () => liveSession },
    setTimeout() {}, setInterval() {},
};
const emit = (event: string, messages?: Entry[]) => Promise.all((handlers.get(event) ?? []).map(handler => handler({ messages }, ctx)));
const timestamp = "2026-01-01T00:00:00.000Z";
const lead = (changes: Partial<{ id: string; cwd: string; sessionId: string; text: string; kind: string; ref: string; timestamp: string }> = {}): Entry => ({
    type: "custom_message", id: changes.id ?? "f2b1ac43", parentId: null, timestamp: changes.timestamp ?? timestamp, customType: "skill-observer", attribution: "user", display: false,
    content: `Leads: ${changes.ref ?? ref} ${changes.text ?? text}`,
    details: { observationLeads: { cwd: changes.cwd ?? cwd, sessionId: changes.sessionId ?? sessionId, leads: [{ ref: changes.ref ?? ref, kind: changes.kind ?? "note", text: changes.text ?? text }] } },
});
const saved = lead();
const synthetic = { role: "user", content: [{ type: "text", text: "Continue" }], synthetic: true, attribution: "agent", timestamp: Date.parse(timestamp) + 2 };
const providerMessage = (entry: Entry) => ({ role: "custom", customType: "skill-observer", display: false, attribution: "user", timestamp: Date.parse(String(entry.timestamp)), content: entry.content, details: entry.details });
const custom = providerMessage(saved);
const run = async (params: unknown = { action: "investigate", lead: ref }, signal?: AbortSignal) => {
    const result = await tool.execute("fixture", params, signal, undefined, ctx);
    return { error: result.isError === true, raw: result.content[0].text, body: JSON.parse(result.content[0].text) };
};
const cue = async (messages: Entry[] = [custom, synthetic]) => JSON.stringify(await emit("context", messages));
const requests: { method: string; path: string; query: string; body?: unknown }[] = [];
const ids = ["947eaa07-3bfc-4bb7-ae40-d71aeb4bb8b3", "f1d44396-e23f-446f-98ab-68a9250c1871", "765cf5ad-b153-40c5-b6de-5ae180301c46"];
const projectTag = "project:project";
const rawFact = (id: string, overrides: Entry = {}) => ({
    id, type: "world", state: "valid", text: `Verified original ${id}`, context: "Prior session", date: "", occurred_start: null, occurred_end: null,
    mentioned_at: timestamp, entities: ["Quill"], tags: [projectTag], metadata: { session_id: "cited-native-session" },
    document_id: null, chunk_id: null, observation_scopes: null, invalidated_at: null, invalidation_reason: null, edited_at: null, ...overrides,
});
const facts = new Map(ids.map(id => [id, rawFact(id)]));
const docs = new Map<string, Entry>();
const chunks: Entry = {};
let recallOverride: Entry | undefined;
let afterRecall: (() => void) | undefined;
const prefix = () => `/v1/default/banks/${settings.scoping === "per-project" ? "team-bank-project" : "team-bank"}`;
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;
    requests.push({ method: request.method, path: url.pathname, query: url.search, body });
    if (!url.pathname.startsWith(prefix() + "/") || request.headers.get("Authorization") !== "Bearer fixture-token") return new Response(null, { status: 403 });
    const route = url.pathname.slice(prefix().length);
    if (request.method === "POST" && route === "/memories/recall") {
        const result = recallOverride ?? { results: [...facts.values()].map(({ id, type, document_id, chunk_id }) => ({ id, type, document_id, chunk_id, text: "Never trust this recall preview" })), chunks };
        afterRecall?.();
        return Response.json(result);
    }
    if (request.method === "GET" && route.startsWith("/memories/")) {
        const fact = facts.get(route.split("/").at(-1)!);
        return fact ? Response.json(fact) : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && route === "/documents") {
        const item = docs.get(url.searchParams.get("q") ?? "");
        return Response.json({ items: item ? [item] : [], total: item ? 1 : 0, offset: 0, limit: 5 });
    }
    return new Response(null, { status: 404 });
} });
settings.hindsightApiUrl = server.url.href;
try {
    await emit("session_start");
    assert.match(await cue(), /hindsight_curate/, "provider context sees the native custom message before the branch");
    assert.equal((await run()).error, true, "the context copy cannot authorize HTTP until persisted");
    const wake = { type: "message", id: "a1a1a1a1", parentId: saved.id, timestamp, message: synthetic };
    branch = [saved, wake];
    assert.match(await cue(), /hindsight_curate/);
    assert.equal(requests.length, 0, "a cue must not start recall");
    const result = await run();
    assert.equal(result.error, false);
    assert.equal(result.body.status, "ok");
    assert.equal(result.body.bank, "team-bank");
    assert.deepEqual(result.body.facts.map((fact: Entry) => fact.id), ids);
    assert.doesNotMatch(result.raw, /Never trust this recall preview/);
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(requests.slice(1).map(request => request.path).sort(), ids.map(id => `${prefix()}/memories/${id}`).sort());
    assert.equal((requests[0].body as Entry).query, text);
    assert.deepEqual((requests[0].body as Entry).tags, [projectTag]);
    assert.equal((requests[0].body as Entry).max_tokens, 128);
    assert.deepEqual((requests[0].body as Entry).types, ["world", "experience"]);

    requests.length = 0;
    const typed = { role: "user", content: [{ type: "text", text: String(saved.content) }], timestamp: Date.parse(timestamp) + 3 };
    for (const [entries, messages] of [
        [[], [typed]],
        [[{ ...saved, type: "message", message: typed }], [typed]],
        [[{ ...saved, attribution: "agent" }], [{ ...custom, attribution: "agent" }]],
        [[lead({ sessionId: "foreign-session" })], [providerMessage(lead({ sessionId: "foreign-session" }))]],
        [[lead({ cwd: "/foreign/project" })], [providerMessage(lead({ cwd: "/foreign/project" }))]],
        [[saved, { type: "message", message: typed }], [custom, typed]],
        [[saved, { type: "reset_boundary" }], [custom, synthetic]],
        [[saved, { type: "custom_message", customType: "skill-prompt" }], [custom, { role: "custom", customType: "skill-prompt" }]],
        [[saved, lead({ id: "later", ref: ids[0], timestamp: "2026-01-02T00:00:00.000Z", text: "The CSS skill repeats its example." })], [custom, providerMessage(lead({ id: "later", ref: ids[0], timestamp: "2026-01-02T00:00:00.000Z", text: "The CSS skill repeats its example." }))]],
        [[lead({ text: "Hindsight bank not reachable after startup." })], [providerMessage(lead({ text: "Hindsight bank not reachable after startup." }))]],
        [[lead({ text: "Hindsight recall has duplicates; clean up the entire bank." })], [providerMessage(lead({ text: "Hindsight recall has duplicates; clean up the entire bank." }))]],
    ] as [Entry[], Entry[]][]) {
        branch = entries;
        assert.equal((await run()).error, true);
        assert.doesNotMatch(await cue(messages), /hindsight_curate/);
    }
    branch = [saved, wake];
    assert.doesNotMatch(await cue([custom, typed]), /hindsight_curate/, "a queued real user prompt supersedes the saved lead");
    for (const params of [{ action: "investigate", lead: ids[0] }, { action: "investigate", lead: text }, { action: "investigate", lead: ref, query: "forged" }, { action: "apply", lead: ref }]) {
        assert.equal((await run(params)).error, true);
    }
    assert.equal((await run(undefined, AbortSignal.abort())).body.reason, "cancelled");

    for (const [set, reset] of [
        [() => { ctx.hasUI = false; }, () => { ctx.hasUI = true; }],
        [() => { ctx.mode = "rpc"; }, () => { ctx.mode = "tui"; }],
        [() => { ctx.agent.kind = "sub"; }, () => { ctx.agent.kind = "main"; }],
        [() => { ctx.ui.formDialog = undefined; }, () => { ctx.ui.formDialog = nativeForm; }],
        [() => { ctx.ui.custom = undefined; }, () => { ctx.ui.custom = nativeForm; }],
        [() => { liveCwd = "/foreign/project"; }, () => { liveCwd = cwd; }],
        [() => { liveSession = "foreign-session"; }, () => { liveSession = sessionId; }],
        [() => { enabled = false; }, () => { enabled = true; }],
        [() => { settings.backend = "off"; }, () => { settings.backend = "hindsight"; }],
    ]) {
        set();
        assert.equal((await run()).error, true);
        assert.doesNotMatch(await cue(), /hindsight_curate/);
        reset();
    }
    await emit("session_tree");
    assert.equal((await run()).error, true, "a lifecycle transition must not reactivate a copied pass");
    assert.doesNotMatch(await cue(), /hindsight_curate/);
    assert.deepEqual(requests, []);

    const observation = "Recalled memories repeat the commit-style fact in twelve entries; merge them into one.";
    const current = lead({ id: "new-pass", kind: "observation", text: observation, timestamp: "2026-01-02T00:00:00.000Z" });
    branch = [saved, wake, current];
    assert.match(await cue([custom, providerMessage(current)]), /hindsight_curate/);
    assert.equal((await run()).error, false);
    assert.equal((requests[0].body as Entry).query, observation);
    const longLead = lead({ id: "long-pass", text: `${text} 😀`, timestamp: "2026-01-03T00:00:00.000Z" });
    branch = [current, longLead];
    settings.recallMaxQueryChars = text.length + 1;
    requests.length = 0;
    assert.equal((await run()).body.truncated, true);
    assert.equal((requests[0].body as Entry).query, text + " ");
    settings.recallMaxQueryChars = 400;
    branch = [current];

    for (const [scoping, admitted] of [
        ["per-project-tagged", [ids[0], ids[1]]],
        ["per-project", [ids[0], ids[1]]],
        ["global", [ids[1]]],
    ] as const) {
        settings.scoping = scoping;
        facts.set(ids[1], rawFact(ids[1], { tags: [] }));
        facts.set(ids[2], rawFact(ids[2], { tags: [projectTag, "project:foreign"], text: "Mixed scope private text" }));
        requests.length = 0;
        const scoped = await run();
        assert.deepEqual(scoped.body.facts.map((fact: Entry) => fact.id), admitted);
        assert.equal(scoped.body.bank, scoping === "per-project" ? "team-bank-project" : "team-bank");
        assert.equal(scoped.body.facts[0].scope.kind, scoping === "global" ? "global" : "project");
        assert.equal(scoped.body.facts.at(-1).scope.kind, scoping === "per-project" ? "project" : "global");
        assert.doesNotMatch(scoped.raw, /Mixed scope private text/);
        if (scoping !== "per-project-tagged") assert.equal((requests[0].body as Entry).tags, undefined);
    }
    settings.scoping = "per-project-tagged";
    for (const overrides of [
        { state: "invalidated", invalidated_at: timestamp, invalidation_reason: "obsolete" }, { state: undefined },
        { id: ids[0] }, { type: "observation" }, { tags: ["project:foreign"] }, { tags: ["audience:private"] },
        { tags: ["project:project", "project:project"] }, { tags: null }, { bank_id: "wrong-bank" },
        { occurred_start: "not a date" }, { metadata: { repo_root: "/foreign/project" } },
        { metadata: ["unattributed"] }, { entities: ["Quill", 42] }, { document_id: null, chunk_id: "orphan" },
        { text: "long ".repeat(2000) },
    ]) {
        facts.set(ids[1], rawFact(ids[1], { text: "Invalid candidate text", ...overrides }));
        recallOverride = { results: ids.map(id => ({ id, type: "world", text: "Never trust recall" })) };
        const validated = await run();
        assert.equal(validated.body.omitted_candidates, true);
        assert.deepEqual(validated.body.facts.map((fact: Entry) => fact.id), [ids[0]]);
        assert.doesNotMatch(validated.raw, /Invalid candidate text|Mixed scope private text|Never trust recall/);
    }
    recallOverride = { items: [] };
    assert.equal((await run()).body.reason, "unsupported_recall_envelope");
    recallOverride = undefined;

    const documentId = "quill-prior";
    const chunkId = "team-bank_quill-prior_0";
    const sourceText = "First-hand discussion of the old Quill instruction; includes private unrelated notes.";
    const document = {
        id: documentId, bank_id: "team-bank", tags: [projectTag], text_length: sourceText.length, created_at: timestamp, updated_at: timestamp,
        document_metadata: { source: "Quill operator transcript", private: "Never project arbitrary metadata" }, original_text: "Never return the whole source",
    };
    facts.set(ids[0], rawFact(ids[0], { document_id: documentId, chunk_id: chunkId }));
    facts.delete(ids[1]); facts.delete(ids[2]);
    docs.set(documentId, document);
    chunks[chunkId] = { id: chunkId, chunk_index: 0, text: sourceText, truncated: false };
    requests.length = 0;
    const sourced = await run();
    assert.equal(sourced.body.facts[0].source.status, "scoped_reference");
    assert.equal(sourced.body.facts[0].source.provenance.source, "Quill operator transcript");
    assert.equal(sourced.body.facts[0].source.excerpt, sourceText.slice(0, Math.floor(sourceText.length / 2)));
    assert.deepEqual(requests.map(request => request.path), [`${prefix()}/memories/recall`, `${prefix()}/memories/${ids[0]}`, `${prefix()}/documents`]);
    assert.doesNotMatch(sourced.raw, /private unrelated notes|Never return the whole source|Never project arbitrary metadata/);
    docs.set(documentId, { ...document, tags: [projectTag, "audience:private"] });
    const hidden = await run();
    assert.equal(hidden.body.facts[0].source.status, "unavailable");
    assert.doesNotMatch(hidden.raw, /quill-prior|First-hand discussion|Quill operator transcript/);
    docs.set(documentId, { ...document, document_metadata: { repo_root: "/foreign/project" } });
    const foreign = await run();
    assert.deepEqual(foreign.body.facts, []);
    assert.equal(foreign.body.omitted_candidates, true);
    assert.doesNotMatch(foreign.raw, /foreign|Verified original|quill-prior/);

    afterRecall = () => { settings.hindsightApiToken = "changed-token"; };
    requests.length = 0;
    assert.equal((await run()).body.reason, "scope_changed");
    assert.deepEqual(requests.map(request => request.method), ["POST"]);
    settings.hindsightApiToken = "fixture-token";
    afterRecall = () => { branch = [current, { type: "reset_boundary" }]; };
    requests.length = 0;
    assert.equal((await run()).body.reason, "pass_changed");
    assert.deepEqual(requests.map(request => request.method), ["POST"]);
    afterRecall = undefined;
    branch = [current];

    facts.clear();
    for (let index = 1; index <= 8; index++) {
        const id = `947eaa07-3bfc-4bb7-ae40-d71aeb4bb8b${index}`;
        facts.set(id, rawFact(id));
    }
    requests.length = 0;
    const capped = await run();
    assert.equal(capped.body.truncated, true);
    assert.equal(capped.body.facts.length, 5);
    assert.equal(requests.length, 6);
} finally { server.stop(true); }
