import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    module("@oh-my-pi/pi-tui", { matchesKey: (input: string, key: string) => input === key, wrapTextWithAnsi: (text: string) => text.split("\n") });
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
const sessionDir = mkdtempSync(path.join(tmpdir(), "hindsight-curation-fixture-"));
const sessionFile = path.join(sessionDir, "session.jsonl");
let persist = true;
registerCuration({
    pi: { settings }, arktype() { return {}; },
    on(name: string, handler: EventHandler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) {
        branch.push({ type: "custom", customType, data, id: `custom-${branch.length}`, parentId: branch.at(-1)?.id });
    },
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    getActiveTools: () => enabled ? ["eval", "hindsight_curate"] : ["eval"],
} as unknown as Parameters<typeof registerCuration>[0]);
const tool = tools.get("hindsight_curate");
assert.ok(tool, "Hindsight extension must register its read-only curation action");

let liveCwd = cwd;
let liveSession = sessionId;
let branch: Entry[] = [];
let siblingEntries: Entry[] = [];
const nativeForm = async () => { throw new Error("Investigation must not open a confirmation"); };
const ctx = {
    cwd, mode: "tui", hasUI: true, agent: { kind: "main" },
    ui: { formDialog: nativeForm as typeof nativeForm | undefined, custom: nativeForm as typeof nativeForm | undefined },
    sessionManager: {
        getBranch: () => [...branch], getEntries: () => [...branch, ...siblingEntries],
        getEntry: (id: string) => branch.find(entry => entry.id === id) ?? siblingEntries.find(entry => entry.id === id),
        getCwd: () => liveCwd, getSessionId: () => liveSession,
        getSessionFile: () => sessionFile, getLeafId: () => branch.at(-1)?.id,
        async ensureOnDisk() {
            if (!persist) throw new Error("Session record unavailable");
            writeFileSync(sessionFile, branch.map(entry => JSON.stringify(entry)).join("\n") + "\n");
        },
    },
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
const run = async (params: unknown = { action: "investigate", lead: ref }, signal?: AbortSignal, callId = "fixture") => {
    const result = await tool.execute(callId, params, signal, undefined, ctx);
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
let patchMode: "ack" | "lost" | "conflict" = "ack";
let retainMode: "ack" | "lost" | "wrong_type" | "wrong_date" | "extra" | "archived_extra" | "missing" | "incompatible" | "unsupported_archive" | "deny_archive" = "ack";
const operations = new Map<string, string>();
const extraId = "49f1eb83-39f1-4761-a997-61b69a139925";
const prefix = () => `/v1/default/banks/${settings.scoping === "per-project" ? "team-bank-project" : "team-bank"}`;
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" || request.method === "PATCH" ? await request.json() : undefined;
    requests.push({ method: request.method, path: url.pathname, query: url.search, body });
    if (request.headers.get("Authorization") !== "Bearer fixture-token") return new Response(null, { status: 403 });
    if (request.method === "GET" && url.pathname === "/openapi.json") {
        return Response.json({ paths: {
            "/v1/default/banks/{bank_id}/memories/{memory_id}": retainMode === "unsupported_archive" ? { get: {} } : { get: {}, patch: {} },
            "/v1/default/banks/{bank_id}/memories": { post: {} },
            "/v1/default/banks/{bank_id}/memories/list": { get: {} },
            "/v1/default/banks/{bank_id}/operations/{operation_id}": { get: {} },
        }, components: { schemas: { RetainRequest: { properties: { operation_id: {}, async: {} } }, MemoryItem: { properties: { strategy: {} } } } } });
    }
    if (!url.pathname.startsWith(prefix() + "/")) return new Response(null, { status: 404 });
    const route = url.pathname.slice(prefix().length);
    if (request.method === "POST" && route === "/memories/recall") {
        const result = recallOverride ?? { results: [...facts.values()].map(({ id, type, document_id, chunk_id }) => ({ id, type, document_id, chunk_id, text: "Never trust this recall preview" })), chunks };
        afterRecall?.();
        return Response.json(result);
    }
    if (request.method === "GET" && route === "/config") {
        return Response.json({ bank_id: prefix().split("/").at(-1), config: { retain_strategies: {
            exact: { retain_extraction_mode: retainMode === "incompatible" ? "verbose" : "chunks", retain_chunk_size: 1000 },
        } } });
    }
    if (request.method === "GET" && route.startsWith("/operations/")) {
        const operation_id = route.split("/").at(-1)!;
        const document_id = operations.get(operation_id);
        return document_id ? Response.json({ operation_id, operation_type: "batch_retain", status: "completed", result_metadata: { document_id, extraction_errors_count: 0 } }) : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && route === "/memories/list") {
        const documentId = url.searchParams.get("document_id");
        const state = url.searchParams.get("state") ?? "valid";
        const items = [...facts.values()].filter(item => item.document_id === documentId && item.state === state).map(item => ({ ...item, fact_type: item.type }));
        return Response.json({ items, total: items.length, offset: 0, limit: 2 });
    }
    if (request.method === "POST" && route === "/memories") {
        const request = body as { async: boolean; operation_id: string; items: Entry[] };
        assert.equal(request.async, true);
        assert.equal(request.items.length, 1);
        const [item] = request.items;
        const documentId = String(item?.document_id);
        assert.equal(item?.strategy, "exact");
        assert.equal(item?.resolve_entities, false);
        assert.equal(operations.has(request.operation_id), false);
        assert.ok(![...facts.values()].some(fact => fact.document_id === documentId));
        const attempt = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).at(-1);
        assert.equal(attempt?.customType, "hindsight-curation-attempt");
        assert.match(JSON.stringify(attempt.data), new RegExp(request.operation_id));
        assert.match(JSON.stringify(attempt.data), new RegExp(documentId));
        assert.doesNotMatch(JSON.stringify(attempt.data), /Quill uses|fixture-token/);
        operations.set(request.operation_id, documentId);
        const date = retainMode === "wrong_date" ? "2025-12-01T00:00:00.000Z" : item?.timestamp === "unset" ? "" : item?.timestamp;
        const row = rawFact(ids[2]!, { text: item?.content, date, mentioned_at: date || null, entities: [],
            type: retainMode === "wrong_type" ? "experience" : "world", tags: item?.tags, metadata: item?.metadata, context: item?.context, document_id: documentId });
        if (retainMode !== "missing") facts.set(ids[2]!, row);
        if (retainMode === "extra" || retainMode === "archived_extra") facts.set(extraId, { ...row, id: extraId,
            state: retainMode === "archived_extra" ? "invalidated" : "valid" } as typeof row);
        return retainMode === "lost" ? new Response(null, { status: 502 })
            : Response.json({ operation_id: request.operation_id, async: true, success: true, bank_id: prefix().split("/").at(-1) });
    }
    if (request.method === "PATCH" && route.startsWith("/memories/")) {
        if (retainMode === "deny_archive") return new Response(null, { status: 403 });
        const id = route.split("/").at(-1)!;
        const fact = facts.get(id);
        assert.equal(fact?.state, "valid");
        assert.deepEqual(Object.keys(body as object).sort(), ["reason", "state"]);
        assert.equal((body as Entry).state, "invalidated");
        const reason = patchMode === "conflict" ? "Another operator archived it" : String((body as Entry).reason);
        facts.set(id, { ...fact!, state: "invalidated", invalidated_at: timestamp, invalidation_reason: reason } as never);
        return patchMode === "lost" ? new Response(null, { status: 502 }) : Response.json(facts.get(id));
    }
    if (request.method === "GET" && route.startsWith("/memories/")) {
        const fact = facts.get(route.split("/").at(-1)!);
        return fact ? Response.json(fact) : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && route === "/documents") {
        const item = docs.get(url.searchParams.get("q") ?? "");
        return Response.json({ items: item ? [item] : [], total: item ? 1 : 0, offset: 0, limit: Number(url.searchParams.get("limit")) });
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
    assert.equal((await run({ action: "investigate", lead: ref, targets: [], keeper: "" })).body.status, "ok",
        "strict provider tool schemas can fill unused optional arguments with empty values");
    requests.splice(4);
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

    const duplicate = 'Quill uses the "blue" calibration dial.\nKeep this line <literal>.';
    const prepare = async (count = 2) => {
        branch = [current];
        facts.clear();
        for (const id of ids.slice(0, count)) facts.set(id, rawFact(id, { text: duplicate }));
        await run();
        requests.length = 0;
    };
    const archive = () => run({ action: "archive", lead: ref, targets: [ids[0]], keeper: ids[1] });
    let review = "";
    const answer = (key: string, duringReview?: () => void, readAll = true) => async (factory: Function) => {
        let decision: unknown;
        const component = factory({ terminal: { rows: 28, columns: 180 }, requestRender() {} }, {}, {}, (value: unknown) => { decision = value; });
        review = component.render(180).join("\n");
        duringReview?.();
        for (let page = 0; readAll && !review.includes("a Archive") && page < 10; page++) {
            component.handleInput("pageDown");
            review += "\n" + component.render(180).join("\n");
        }
        component.handleInput(key);
        return decision;
    };
    for (const [mode, key, edit] of [
        ["declined", "enter", undefined],
        ["dismissed", "escape", undefined],
        ["branch changed", "a", () => { branch = [current, { type: "reset_boundary" }]; }],
        ["token changed", "a", () => { settings.hindsightApiToken = "changed"; }],
        ["keeper changed", "a", () => { facts.set(ids[1], rawFact(ids[1], { text: "historical distinction" })); }],
    ] as const) {
        await prepare();
        ctx.ui.custom = answer(key, edit) as unknown as typeof nativeForm;
        await archive();
        assert.equal(requests.some(request => request.method === "PATCH"), false, mode);
        settings.hindsightApiToken = "fixture-token";
    }
    await prepare();
    ctx.ui.custom = answer("a", undefined, false) as unknown as typeof nativeForm;
    assert.equal((await archive()).body.reason, "declined", "approval before the last page cannot authorize a shortened review");
    assert.equal(requests.some(request => request.method === "PATCH"), false);

    const timeout = AbortSignal.timeout;
    try {
        AbortSignal.timeout = ms => ms === 120_000 ? AbortSignal.abort() : timeout(ms);
        ctx.ui.custom = (async (_factory: unknown, options: { signal: AbortSignal }) => options.signal.throwIfAborted()) as unknown as typeof nativeForm;
        assert.equal((await archive()).body.reason, "timeout");
        assert.equal(requests.some(request => request.method === "PATCH"), false);
    } finally { AbortSignal.timeout = timeout; }

    facts.set(ids[0], rawFact(ids[0], { text: duplicate, occurred_start: "2022-01-01T00:00:00.000Z" }));
    await run();
    assert.equal((await archive()).body.reason, "no_complete_same_scope_keeper");
    assert.equal(requests.some(request => request.method === "PATCH"), false);

    await prepare();
    ctx.ui.custom = answer("a") as unknown as typeof nativeForm;
    persist = false;
    assert.equal((await archive()).body.reason, "attempt_not_saved");
    assert.equal(requests.some(request => request.method === "PATCH"), false);
    persist = true;
    for (const mode of ["ack", "lost", "conflict"] as const) {
        await prepare();
        patchMode = mode;
        const applied = await archive();
        assert.ok(review.includes(ids[0]) && review.includes(ids[1]) && review.includes("Keep this line <literal>"));
        assert.equal(requests.filter(request => request.method === "PATCH").length, 1);
        assert.equal(facts.get(ids[0])?.state, "invalidated");
        assert.equal(facts.get(ids[0])?.text, duplicate);
        assert.equal(facts.get(ids[1])?.state, "valid");
        const attempt = branch.find(entry => entry.customType === "hindsight-curation-attempt");
        assert.ok(attempt);
        assert.doesNotMatch(JSON.stringify(attempt), /Keep this line|fixture-token/);
        assert.doesNotMatch(applied.raw, /Keep this line/);
        if (mode === "ack") assert.deepEqual(applied.body.archived, [ids[0]]);
        else if (mode === "lost") assert.deepEqual(applied.body.observedArchived, [ids[0]]);
        else assert.deepEqual(applied.body.unknown, [ids[0]]);
    }

    const batch = { action: "archive", lead: ref, targets: [ids[0], ids[2]], keeper: ids[1] };
    const invocation = { type: "message", id: "archive-call", parentId: current.id,
        message: { role: "assistant", content: [{ type: "toolCall", id: "fixture", name: "hindsight_curate" }] } };
    for (const mode of ["ack", "lost", "conflict"] as const) {
        await prepare(3);
        branch.push(invocation);
        for (const targets of [[ids[0], ids[0]], [ids[0], ids[1]]]) {
            assert.equal((await run({ ...batch, targets })).body.reason, "invalid_input");
        }
        assert.equal(requests.length, 0);
        patchMode = mode;
        const applied = await run(batch);
        const attempt = branch.find(entry => entry.customType === "hindsight-curation-attempt");
        assert.deepEqual((attempt?.data as Entry)?.targetIds, batch.targets);
        assert.deepEqual(requests.filter(request => request.method === "PATCH").map(request => request.path),
            (mode === "ack" ? batch.targets : [ids[0]]).map(id => prefix() + `/memories/${id}`));
        assert.deepEqual(applied.body.archived, mode === "ack" ? batch.targets : []);
        assert.deepEqual(applied.body.observedArchived, mode === "lost" ? [ids[0]] : []);
        assert.deepEqual(applied.body.unchanged, mode === "ack" ? [] : [ids[2]]);
        assert.deepEqual(applied.body.unknown, mode === "conflict" ? [ids[0]] : []);
        assert.ok(batch.targets.every(id => review.includes(id)) && review.includes(ids[1]));
    }
    assert.equal(facts.get(ids[2])?.state, "valid");
    const interrupted = branch.pop()!;
    assert.equal(interrupted.customType, "hindsight-curation-attempt");
    const attemptId = (interrupted.data as Entry).id;
    siblingEntries = [interrupted];
    await emit("session_start");
    ctx.ui.custom = nativeForm;
    requests.length = 0;
    const recovered = await run({ action: "reconcile", attempt: attemptId, lead: ref });
    assert.deepEqual(recovered.body.unknown, [ids[0]], "a conflicting archive reason is not attributed to the attempt");
    assert.deepEqual(recovered.body.unchanged, [ids[2]]);
    assert.deepEqual((await run(batch)).body.unchanged, [ids[2]], "replayed archive calls can only reconcile");
    assert.ok(requests.length && requests.every(request => request.method === "GET"));
    requests.length = 0;
    settings.hindsightApiToken = "changed";
    assert.deepEqual((await run({ action: "reconcile", attempt: attemptId })).body.unknown, batch.targets);
    settings.hindsightApiToken = "fixture-token";
    branch = [];
    assert.equal((await run({ action: "reconcile", attempt: attemptId })).body.reason, "attempt_not_in_branch");
    assert.equal(requests.length, 0);

    patchMode = "ack";
    facts.set(ids[0], rawFact(ids[0], { text: "The retired Quill lookup code is BLUE." }));
    facts.set(ids[1], rawFact(ids[1], { text: "In 2022 the Quill lookup code was BLUE.", occurred_start: "2022-01-01" }));
    const obsolete = (id: string) => run({ action: "obsolete", lead: ref, targets: [id], keeper: null });
    const attestation = `I confirm Hindsight fact ${ids[0]} is obsolete and has no remaining use, including as history.`;
    for (const [message, kind] of [
        ["Hindsight's Quill lookup code fact might be obsolete; the search did not find a use.", "note"],
        [attestation, "observation"],
        [`Do not treat this as my attestation: "${attestation}"`, "note"],
    ]) {
        branch = [lead({ id: "uncertain-obsolete", text: message, kind })];
        await run();
        requests.length = 0;
        assert.equal((await obsolete(ids[0])).body.reason, "obsolescence_not_established");
        assert.equal(requests.length, 0);
    }
    branch = [lead({ id: "obsolete-pass", text: `The fixture Quill lookup code was temporary. ${attestation}` })];
    await run();
    requests.length = 0;
    assert.equal((await obsolete(ids[1])).body.reason, "obsolescence_not_established", "an attestation for one fact cannot retire its historical counterpart");
    ctx.ui.custom = answer("a") as unknown as typeof nativeForm;
    assert.deepEqual((await obsolete(ids[0])).body.archived, [ids[0]]);
    assert.match(review, /no replacement/i);
    assert.match(review, /retired Quill lookup code/);
    assert.equal(facts.get(ids[0])?.text, "The retired Quill lookup code is BLUE.");
    assert.match(String(facts.get(ids[0])?.invalidation_reason), /obsolete.*no remaining use/i);
    assert.equal(facts.get(ids[1])?.state, "valid");
    assert.deepEqual(requests.filter(request => request.method !== "GET").map(request => [request.method, request.path]), [
        ["PATCH", `${prefix()}/memories/${ids[0]}`],
    ]);

    const corrected = "Quill uses the GREEN fixture release key.";
    const correction = `Hindsight has the wrong Quill fixture release key. I confirm Hindsight fact ${ids[0]} is incorrect and the exact correction preserves its still-useful details. Exact replacement: ${corrected}`;
    const replace = () => run({ action: "replace", lead: ref, targets: [ids[0]] });
    for (const mode of ["incompatible", "unsupported_archive", "wrong_type", "wrong_date", "extra", "archived_extra", "missing", "deny_archive", "lost", "ack"] as const) {
        facts.clear();
        docs.clear();
        operations.clear();
        facts.set(ids[0]!, rawFact(ids[0]!, { text: "Quill uses the obsolete BLUE fixture release key.", date: timestamp, entities: [] }));
        branch = [lead({ id: "correction-pass", text: correction })];
        retainMode = mode;
        await run();
        requests.length = 0;
        const result = await replace();
        const writes = requests.filter(request => request.method !== "GET");
        if (mode === "incompatible" || mode === "unsupported_archive") {
            assert.equal(result.body.status, "unavailable", mode);
            assert.equal(writes.length, 0, mode);
            assert.equal(facts.get(ids[0]!)?.state, "valid");
            continue;
        }
        assert.equal(writes.filter(write => write.method === "POST").length, 1, mode);
        assert.match(review, /can remain active if/i);
        assert.ok(review.includes(corrected));
        assert.doesNotMatch(result.raw, /Quill uses/);
        assert.equal(typeof result.body.replacement.documentId, "string");
        assert.equal(typeof result.body.replacement.operationId, "string");
        if (mode === "ack" || mode === "lost") {
            assert.deepEqual(result.body.archived, [ids[0]], mode);
            assert.equal(result.body.keeper, ids[2]);
            assert.equal(facts.get(ids[2]!)?.text, corrected);
            assert.equal(facts.get(ids[2]!)?.date, timestamp);
        } else {
            assert.deepEqual(result.body.unchanged, [ids[0]], mode);
            assert.equal(facts.get(ids[0]!)?.state, "valid", mode);
            assert.equal(writes.some(write => write.method === "PATCH"), mode === "deny_archive", mode);
        }
        if (mode === "missing") {
            requests.length = 0;
            const repeated = await run({ action: "replace", lead: ref, targets: [ids[0]] }, undefined, "not-a-retry");
            assert.equal(repeated.body.reason, "replacement_attempt_exists");
            assert.equal(repeated.body.replacement.operationId, result.body.replacement.operationId);
            assert.ok(requests.every(request => request.method === "GET"));
        }
        if (mode === "deny_archive") {
            assert.equal(result.body.status, "retained_only");
            assert.equal(result.body.keeper, ids[2]);
            retainMode = "ack";
            await run();
            requests.length = 0;
            const reused = await run({ action: "archive", lead: ref, targets: [ids[0]], keeper: ids[2] }, undefined, "new-keeper-review");
            assert.deepEqual(reused.body.archived, [ids[0]], "a new confirmation can reuse the verified replacement without another retain");
            assert.ok(requests.every(request => request.method !== "POST"));
        }
    }
} finally { server.stop(true); rmSync(sessionDir, { recursive: true, force: true }); }
