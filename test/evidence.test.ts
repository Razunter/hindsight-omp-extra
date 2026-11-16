import { afterAll, afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface TestItem extends Record<string, unknown> { id: string; excerpt: string; }
interface TestEnvelope extends Record<string, unknown> { items: TestItem[]; status: string; }
interface TestTool { execute(id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: { cwd: string; sessionManager: { saveArtifact(content: string, toolType: string): Promise<string | undefined> } }): Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>; }

const values: Record<string, unknown> = {
    "memory.backend": "hindsight", "hindsight.apiUrl": "", "hindsight.apiToken": "synthetic-token",
    "hindsight.bankId": "bank", "hindsight.bankIdPrefix": "", "hindsight.scoping": "per-project-tagged",
    "hindsight.recallBudget": "mid", "hindsight.recallMaxTokens": 1024,
    "hindsight.recallMaxQueryChars": 800, "hindsight.recallTypes": ["world", "experience"], "hindsight.recallTimeoutMs": 1000,
};
let primaryRoot: string | undefined = "/repo/Project";
Bun.plugin({ name: "evidence-host-boundary", setup(build) {
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({ exports: { lookup: (id: string) => ({ get: () => values[id] }) }, loader: "object" }));
    build.module("@oh-my-pi/pi-natives/vcs", () => ({ exports: { repo: () => primaryRoot ? { primaryRoot: () => primaryRoot } : undefined }, loader: "object" }));
} });
const { registerEvidence } = await import("../src/evidence");
const proxyBypass = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
for (const key of ["NO_PROXY", "no_proxy"] as const) process.env[key] = [proxyBypass[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
afterAll(() => {
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
        if (proxyBypass[key] === undefined) delete process.env[key]; else process.env[key] = proxyBypass[key];
    }
});

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    values["memory.backend"] = "hindsight"; values["hindsight.scoping"] = "per-project-tagged";
    values["hindsight.bankId"] = "bank"; values["hindsight.bankIdPrefix"] = "";
    values["hindsight.recallMaxQueryChars"] = 800; values["hindsight.recallTimeoutMs"] = 1000;
    primaryRoot = "/repo/Project";
});
function fixture(handler: (request: Request) => Response | Promise<Response>) {
    const requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    const artifacts = new Map<string, string>();
    const sessionManager = { async saveArtifact(content: string, _toolType: string): Promise<string | undefined> {
        const id = String(artifacts.size);
        artifacts.set(id, content);
        return id;
    } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        requests.push({ url: request.url, method: request.method, body: request.method === "POST" ? await request.clone().json() : undefined });
        return handler(request);
    } });
    servers.push(server); values["hindsight.apiUrl"] = server.url.href;
    let tool: TestTool;
    // The owned host double implements only the registrar’s documented seams.
    const host = { arktype: (_schema: unknown) => ({}), pi: { settings: {} }, registerTool(definition: TestTool) { tool = definition; } } as unknown as ExtensionAPI;
    registerEvidence(host);
    return { requests, artifacts, sessionManager, async run(params: unknown, signal?: AbortSignal, cwd = "/repo/worktrees/other") {
        const result = await tool.execute("fixture", params, signal, undefined, { cwd, sessionManager });
        expect(result.details).not.toHaveProperty("items");
        expect(result.content).toHaveLength(1);
        const text = result.content[0].text;
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
        const envelope: TestEnvelope = JSON.parse(text);
        return { ...envelope, isError: result.isError, raw: text };
    } };
}
const fact = (id: string, tags: unknown = ["project:project"], extra: Record<string, unknown> = {}) => ({ id, text: "evidence " + id, type: "world", tags, ...extra });
const recall = (results: unknown[], source_facts: unknown = {}, extra: Record<string, unknown> = {}) => Response.json({ results, source_facts, source_facts_truncated: false, ...extra });

test("allowed observation cannot disclose excluded support text, IDs or provenance", async () => {
    const f = fixture(request => new URL(request.url).pathname.endsWith("/memories/recall") ? recall([fact("observation", ["project:project"], { type: "observation", source_fact_ids: ["allowed", "secret", "absent"] })], {
        allowed: fact("allowed", [], { document_id: "retained", context: "origin" }),
        secret: fact("secret", ["project:other"], { document_id: "secret-document", text: "forbidden" }),
    }) : new Response(null, { status: 404 }));
    const result = await f.run({ action: "source_search", query: " evidence " });
    expect(result.status).toBe("ok");
    expect(result.items.map(item => item.id)).toEqual(["observation", "allowed"]);
    expect(result.items[0].source_fact_ids).toEqual(["allowed"]);
    expect(result.items[0].synthesis).toBe(true);
    expect(result.items[1].document_id).toBe("retained");
    expect(result.omitted_evidence).toBe(true);
    for (const excluded of ["secret", "absent", "forbidden"]) expect(result.raw).not.toContain(excluded);
    expect(f.requests.map(request => request.method)).toEqual(["POST"]);
    expect(f.requests[0].body).toMatchObject({ query: "evidence", tags: ["project:project"], tags_match: "any", budget: "mid", max_tokens: 1024, types: ["world", "experience"] });
    expect(f.requests[0].body.include).not.toHaveProperty("chunks");
});

test("requested source facts may be null without inventing observation support", async () => {
    const f = fixture(() => recall([fact("ordinary", [], { document_id: "doc" }), fact("observation", [], { type: "observation", source_fact_ids: ["unreturned"] })], null));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("ok");
    expect(result.items.map(item => item.id)).toEqual(["ordinary", "observation"]);
    expect(result.items[0].document_id).toBe("doc");
    expect(result.items[1]).toMatchObject({ synthesis: true, support: "unavailable", source_fact_ids: [] });
    expect(result.omitted_evidence).toBe(true); expect(result.raw).not.toContain("unreturned");
});

test.each([
    { action: "source_search", query: " " }, { action: "source_search", query: "x", bank: "other" },
    { action: "source_search", query: "x", id: "extra" }, { action: "unknown", query: "x" },
    { action: "page_search", id: "" }, { action: "page_read", query: "", id: "" }, { action: "page_read", query: "x", id: "page" },
    { action: "page_search", query: "x", id: "", bank: "" },
])("invalid input is rejected without HTTP: %j", async params => {
    const f = fixture(() => recall([]));
    expect((await f.run(params)).status).toBe("error"); expect(f.requests).toEqual([]);
});

// Models fill every advertised field, sending "" for the one the action does not use.
test.each([
    { action: "page_search", query: "Quill project's synthesized overview of component boundaries", id: "" },
    { action: "source_search", query: "supporting source", id: "" },
    { action: "page_read", query: "", id: "page" },
    { action: "source_read", query: "", id: "timeout-note" },
])("an empty inactive field does not block the action: %j", async params => {
    const f = fixture(request => fetchedEvidence(request, "evidence body"));
    const result = await f.run(params);
    expect(result.status).toBe("ok");
    expect(result.items.length).toBeGreaterThan(0);
    if (params.action === "source_read") expect(result.items[0].id).toBe("timeout-note");
    if (params.action === "page_read") expect(result.items[0].id).toBe("page");
});

test("non-Hindsight configuration fails without HTTP", async () => {
    const f = fixture(() => recall([])); values["memory.backend"] = "off";
    expect((await f.run({ action: "source_search", query: "x" })).status).toBe("unavailable");
    expect(f.requests).toEqual([]);
});

test("scope and query limits are re-resolved and primary repository identity wins over worktree cwd", async () => {
    const f = fixture(() => recall([fact("global", [])]));
    values["hindsight.recallMaxQueryChars"] = 2;
    expect((await f.run({ action: "source_search", query: "😀abc" })).query_truncated).toBe(true);
    expect(f.requests[0].body.query).toBe("😀a");
    values["hindsight.scoping"] = "per-project"; values["hindsight.bankIdPrefix"] = " team ";
    await f.run({ action: "source_search", query: "x" });
    expect(decodeURIComponent(new URL(f.requests[1].url).pathname.split("/")[4])).toBe("team-bank-project");
    primaryRoot = undefined;
    await f.run({ action: "source_search", query: "x" }, undefined, "/outside/Folder");
    expect(decodeURIComponent(new URL(f.requests[2].url).pathname.split("/")[4])).toBe("team-bank-folder");
    values["hindsight.scoping"] = "global";
    await f.run({ action: "source_search", query: "x" });
    expect(f.requests[3].body).not.toHaveProperty("tags");
});

test.each([undefined, null, "project:project", [42]])("missing or malformed tags cannot authorize a global fact: %j", async tags => {
    const record = fact("unsafe", tags); if (tags === undefined) delete record.tags;
    const f = fixture(() => recall([record]));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("error"); expect(result.raw).not.toContain("unsafe");
});

test("omitted scoped evidence differs from a genuinely empty search", async () => {
    let excluded = true;
    const f = fixture(() => recall(excluded ? [fact("excluded", ["project:other"])] : []));
    const denied = await f.run({ action: "source_search", query: "x" });
    expect(denied.status).toBe("empty"); expect(denied.omitted_evidence).toBe(true); expect(denied.isError).not.toBe(true);
    excluded = false;
    expect((await f.run({ action: "source_search", query: "x" })).omitted_evidence).not.toBe(true);
});

test("search clips Unicode, bounds results and reports source-fact truncation", async () => {
    const f = fixture(() => recall(Array.from({ length: 7 }, (_, i) => fact(String(i), [], { text: "😀".repeat(1000) })), {}, { source_facts_truncated: true }));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.items).toHaveLength(5); expect(result.truncated).toBe(true); expect(result.source_facts_truncated).toBe(true);
    expect(Array.from(result.items[0].excerpt)).toHaveLength(512);
    expect(result.raw).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test.each([401, 403, 429, 500])("HTTP %i is a bounded failure without error body leakage", async status => {
    const f = fixture(() => new Response("synthetic-sensitive-error", { status }));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.isError).toBe(true); expect(result.status).toBe("error"); expect(result.raw).not.toContain("synthetic-sensitive-error");
});

test.each([{}, { results: [], source_facts: null }, { results: [], source_facts: {} }, { results: [], source_facts: { mismatch: fact("different") }, source_facts_truncated: false }])("unsupported or malformed source contract fails closed", async body => {
    const f = fixture(() => Response.json(body));
    expect((await f.run({ action: "source_search", query: "x" })).isError).toBe(true);
});

test("response size is bounded before parsing", async () => {
    const f = fixture(() => new Response("x".repeat(1048577)));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("error"); expect(result.category).toBe("too_large");
});

test("already cancelled invocation makes no request", async () => {
    const f = fixture(() => recall([]));
    const result = await f.run({ action: "source_search", query: "x" }, AbortSignal.abort());
    expect(result.category).toBe("cancelled"); expect(f.requests).toEqual([]);
});

test("deadline and invocation cancellation bound pending HTTP", async () => {
    // Real HTTP cancellation must exercise the platform clock, not only a mocked timer.
    const f = fixture(request => new Promise<Response>(resolve => { request.signal.addEventListener("abort", () => resolve(recall([])), { once: true }); }));
    values["hindsight.recallTimeoutMs"] = 10;
    expect((await f.run({ action: "source_search", query: "x" })).category).toBe("deadline");
    values["hindsight.recallTimeoutMs"] = 1000;
    expect((await f.run({ action: "source_search", query: "x" }, AbortSignal.timeout(10))).category).toBe("cancelled");
});

test("source search can finish after ten seconds within the configured recall deadline", async () => {
    // AbortSignal.timeout uses the platform clock, so real HTTP must cross the old ten-second deadline.
    const f = fixture(async () => {
        await Bun.sleep(10_100);
        return recall([fact("slow-source", [], { document_id: "slow-document" })]);
    });
    values["hindsight.recallTimeoutMs"] = 30_000;
    const result = await f.run({ action: "source_search", query: "slow evidence" });
    expect(result.status).toBe("ok");
    expect(result.items.map(item => item.document_id)).toEqual(["slow-document"]);
}, 20_000);

test("available allowlisted provenance is preserved without arbitrary metadata", async () => {
    const f = fixture(() => recall([fact("fact", [], { metadata: { source: "handbook", title: "Guide", token: "forbidden-metadata" } })]));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.items[0].provenance).toEqual({ source: "handbook", title: "Guide" });
    expect(result.raw).not.toContain("forbidden-metadata");
});

test("JSON byte clipping retains item identifiers while reducing metadata and excerpt text", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => String(index) + "x".repeat(400));
    const f = fixture(() => recall(ids.map(id => fact(id, [], { text: "😀".repeat(512), context: "😀".repeat(512), metadata: { title: "😀".repeat(512) } }))));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("ok"); expect(result.truncated).toBe(true);
    expect(result.items.map(item => item.id)).toEqual(ids);
    const snapshot = savedResult(f.artifacts, result.full_output);
    expect(snapshot.items.map(item => item.id)).toEqual(ids);
    for (const item of snapshot.items) {
        expect(decodedText(item.excerpt)).toBe("😀".repeat(512));
        expect(decodedText(item.context)).toBe("😀".repeat(512));
        expect(item.provenance).toEqual({ title: "😀".repeat(512) });
    }
});

const documentRecord = (id = "doc", extra: Record<string, unknown> = {}) => ({ id, bank_id: "bank", original_text: "original retained text", tags: ["project:project"], document_metadata: { source: "handbook", token: "forbidden-metadata" }, created_at: "2026-10-12T00:00:00Z", ...extra });

test("document read retrieves retained text with independent bank/ID/tags and safe provenance", async () => {
    const id = "folder/name ?#% ü";
    const f = fixture(() => Response.json(documentRecord(id)));
    const result = await f.run({ action: "source_read", id });
    expect(result.status).toBe("ok"); expect(result.items[0]).toMatchObject({ kind: "document", id, text: "original retained text", provenance: { source: "handbook" }, created_at: "2026-10-12T00:00:00Z" });
    expect(result.raw).not.toContain("forbidden-metadata");
    expect(f.requests.map(request => request.method)).toEqual(["GET"]);
    expect(new URL(f.requests[0].url).pathname).toBe("/v1/default/banks/bank/documents/" + encodeURIComponent(id));
});

test.each([{ tags: ["project:other"] }, { bank_id: "other" }, { id: "wrong" }])("document denial reveals no document content or identifiers: %j", async override => {
    const f = fixture(() => Response.json(documentRecord("forbidden-document", { ...override, original_text: "forbidden-document-text" })));
    const result = await f.run({ action: "source_read", id: "forbidden-document" });
    expect(result.status).toBe("unavailable"); expect(result.isError).toBe(true);
    expect(result.raw).not.toContain("forbidden-document"); expect(result.items).toEqual([]);
    expect(result).not.toHaveProperty("full_output"); expect(f.artifacts.size).toBe(0);
});

test.each([{}, { id: "doc", original_text: "forbidden", tags: [] }, documentRecord("doc", { tags: null }), documentRecord("doc", { original_text: 42 })])("malformed document contract fails closed", async body => {
    const f = fixture(() => Response.json(body));
    const result = await f.run({ action: "source_read", id: "doc" });
    expect(result.status).toBe("error"); expect(result.raw).not.toContain("forbidden");
    expect(result).not.toHaveProperty("full_output"); expect(f.artifacts.size).toBe(0);
});

test("document scope is fresh after a search, retagging and configuration changes", async () => {
    let tags = ["project:project"];
    const f = fixture(request => request.method === "POST" ? recall([fact("hit", [], { document_id: "doc" })]) : Response.json(documentRecord("doc", { tags })));
    await f.run({ action: "source_search", query: "x" });
    expect((await f.run({ action: "source_read", id: "doc" })).status).toBe("ok");
    tags = ["project:other"];
    expect((await f.run({ action: "source_read", id: "doc" })).status).toBe("unavailable");
    primaryRoot = "/repo/Other";
    expect((await f.run({ action: "source_read", id: "doc" })).status).toBe("ok");
    values["hindsight.bankId"] = "changed";
    expect((await f.run({ action: "source_read", id: "doc" })).status).toBe("unavailable");
    expect(f.requests.map(request => request.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    expect(new URL(f.requests[4].url).pathname).toBe("/v1/default/banks/changed/documents/doc");
});

test("empty retained text is not replaced by synthesis and untagged globals remain readable", async () => {
    const f = fixture(() => Response.json(documentRecord("doc", { original_text: "", tags: [], document_metadata: null })));
    const result = await f.run({ action: "source_read", id: "doc" });
    expect(result.status).toBe("ok"); expect(result.items[0].text).toBe("");
    expect(result.items[0].content_empty).toBe(true); expect(result.items[0].provenance).toBe("unavailable");
});

test("document reads obey Unicode and JSON byte limits without rewriting IDs", async () => {
    const f = fixture(() => Response.json(documentRecord("doc", { original_text: "😀".repeat(9000) })));
    const result = await f.run({ action: "source_read", id: "doc" });
    expect(result.status).toBe("ok"); expect(result.truncated).toBe(true); expect(result.items[0].id).toBe("doc");
    expect(Array.from(String(result.items[0].text)).length).toBeLessThanOrEqual(8192);
    expect(String(result.items[0].text)).toMatch(/^(?:😀)+$/u);
});

test.each(["", " ", ".", "..", "x".repeat(513), "\ud800"]) ("invalid document ID makes no HTTP request", async id => {
    const f = fixture(() => Response.json(documentRecord()));
    expect((await f.run({ action: "source_read", id })).status).toBe("error"); expect(f.requests).toEqual([]);
});

test.each([404, 401, 500])("document HTTP %i is explicit and bounded", async status => {
    const f = fixture(() => new Response("forbidden-error", { status }));
    const result = await f.run({ action: "source_read", id: "doc" });
    expect(result.status).toBe(status === 404 ? "unavailable" : "error"); expect(result.raw).not.toContain("forbidden-error");
});

test("cancelled document read and excessive responses use shared error limits", async () => {
    const f = fixture(() => new Response("x".repeat(1048577)));
    expect((await f.run({ action: "source_read", id: "doc" }, AbortSignal.abort())).category).toBe("cancelled");
    expect(f.requests).toEqual([]);
    expect((await f.run({ action: "source_read", id: "doc" })).category).toBe("too_large");
});

test.each(["global", "per-project"]) ("document tags must be a valid current array even in %s mode", async scoping => {
    values["hindsight.scoping"] = scoping;
    const bank = scoping === "global" ? "bank" : "bank-project";
    const f = fixture(() => Response.json({ id: "doc", bank_id: bank, original_text: "forbidden-document" }));
    const result = await f.run({ action: "source_read", id: "doc" });
    expect(result.status).toBe("error"); expect(result.raw).not.toContain("forbidden-document");
});

test("identity-heavy source results select a bounded subset without rewriting IDs", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => String(i) + "\u0001".repeat(500));
    const supports = Object.fromEntries(ids.map(id => [id, fact(id, [], { document_id: id })]));
    const f = fixture(() => recall([fact("parent", [], { type: "observation", source_fact_ids: ids })], supports));
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("ok"); expect(result.truncated).toBe(true); expect(result.items[0].id).toBe("parent");
    for (const item of result.items) expect(["parent", ...ids]).toContain(item.id);
    expect(result.items.length).toBeLessThanOrEqual(5);
    const snapshot = savedResult(f.artifacts, result.full_output);
    expect(snapshot.items.map(item => item.id)).toEqual(["parent", ...ids]);
    expect(snapshot.items[0].source_fact_ids).toEqual(ids);
    expect(snapshot.items.slice(1).map(item => item.document_id)).toEqual(ids);
});

test.each([200, 401, 404])("failing stream cleanup cannot replace size/status classification (%i)", async status => {
    const f = fixture(() => recall([]));
    const originalFetch = globalThis.fetch;
    const failingBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel() { throw new Error("sensitive-cleanup-error"); } });
    // This transport double exercises an otherwise nondeterministic fetch cleanup failure.
    const transport = async () => new Response(failingBody, { status });
    globalThis.fetch = transport as typeof fetch;
    try {
        const result = await f.run({ action: "source_search", query: "x" });
        expect(result.category).toBe(status === 200 ? "too_large" : status === 401 ? "authentication" : "missing");
        expect(result.raw).not.toContain("sensitive-cleanup-error");
    } finally { globalThis.fetch = originalFetch; }
});

test.each(["global", "per-project"]) ("malformed fact/support tags fail even without a tag filter (%s)", async scoping => {
    values["hindsight.scoping"] = scoping;
    let support = false;
    const f = fixture(() => support ? recall([], { bad: fact("bad", 123) }) : recall([fact("bad", 123)]));
    expect((await f.run({ action: "source_search", query: "x" })).category).toBe("scope_schema");
    support = true;
    expect((await f.run({ action: "source_search", query: "x" })).category).toBe("scope_schema");
});

test("connection failure is bounded and never exposes transport internals", async () => {
    const f = fixture(() => recall([]));
    servers.at(-1)!.stop(true);
    const result = await f.run({ action: "source_search", query: "x" });
    expect(result.status).toBe("error"); expect(result.category).toBe("network");
    expect(result.items).toEqual([]); expect(result.raw).not.toContain("127.0.0.1");
});

test("irrelevant document-read fields are rejected before HTTP", async () => {
    const f = fixture(() => Response.json(documentRecord()));
    expect((await f.run({ action: "source_read", id: "doc", query: "unused" })).category).toBe("invalid_input");
    expect(f.requests).toEqual([]);
});

const page = (extra: Record<string, unknown> = {}) => ({ id: "page", name: "Decision", type: "mental_model", tags: ["project:project"], body: "Current synthesized rationale", markdown: "stale frontmatter", timestamp: "2026-10-12", ...extra });

test("page read returns current synthesized body with fresh scope", async () => {
    let tags = ["project:project"];
    const f = fixture(() => Response.json(page({ tags })));
    const read = await f.run({ action: "page_read", id: "page" });
    expect(read.status).toBe("ok");
    expect(read.items[0]).toMatchObject({ kind: "knowledge_page", id: "page", name: "Decision", text: "Current synthesized rationale", synthesis: true, provenance: "unavailable", timestamp: "2026-10-12" });
    expect(read.raw).not.toContain("stale frontmatter");
    tags = ["project:other"];
    const denied = await f.run({ action: "page_read", id: "page" });
    expect(denied.status).toBe("unavailable"); expect(denied.items).toEqual([]);
    expect(denied.raw).not.toContain("Current synthesized");
    expect(denied).not.toHaveProperty("full_output"); expect(f.artifacts.size).toBe(0);
    expect(f.requests.map(r => new URL(r.url).pathname)).toEqual(["/v1/default/banks/bank/knowledge-base/pages/page", "/v1/default/banks/bank/knowledge-base/pages/page"]);
});
test.each([{ tags: [] }, { tags: ["project:project"] }])("page read permits current and explicitly global pages: %j", async ({ tags }) => {
    const f = fixture(() => Response.json(page({ tags })));
    expect((await f.run({ action: "page_read", id: "page" })).items[0].text).toBe("Current synthesized rationale");
});
test.each([{ id: "different" }, { tags: undefined }, { tags: "project:project" }, { body: undefined }, { name: 3 }])("malformed or mismatched page is withheld: %j", async extra => {
    const f = fixture(() => Response.json(page(extra)));
    const read = await f.run({ action: "page_read", id: "page" });
    expect(["error", "unavailable"]).toContain(read.status); expect(read.items).toEqual([]);
    expect(read.raw).not.toContain("Current synthesized rationale");
    expect(read).not.toHaveProperty("full_output"); expect(f.artifacts.size).toBe(0);
});
test("empty page body never becomes rendered placeholder evidence", async () => {
    const f = fixture(() => Response.json(page({ body: "", markdown: "No content yet." })));
    const read = await f.run({ action: "page_read", id: "page" });
    expect(read.items[0]).toMatchObject({ text: "", content_empty: true, synthesis: true });
    expect(read.raw).not.toContain("No content yet.");
});
test("page read preserves Unicode limits and safe opaque IDs", async () => {
    const id = "page/with?query#fragment";
    const f = fixture(() => Response.json(page({ id, body: "😀".repeat(10000), name: "😀".repeat(10000) })));
    const read = await f.run({ action: "page_read", id });
    expect(read.status).toBe("ok"); expect(read.truncated).toBe(true); expect(read.items[0].id).toBe(id);
    expect(Array.from(String(read.items[0].text)).length).toBeLessThanOrEqual(8192);
    expect(String(read.items[0].text).isWellFormed()).toBe(true);
    expect(f.requests[0].url).toContain(encodeURIComponent(id));
});
test("page read cancellation and missing page use bounded errors", async () => {
    const missing = fixture(() => new Response("private server error", { status: 404 }));
    expect(await missing.run({ action: "page_read", id: "page" })).toMatchObject({ status: "unavailable", category: "missing", items: [] });
    const controller = new AbortController(); controller.abort();
    expect((await missing.run({ action: "page_read", id: "page" }, controller.signal)).category).toBe("cancelled"); expect(missing.requests).toHaveLength(1);
});

const pageHits = (ids: string[]) => Response.json({ results: ids.map(id => ({ id, name: "UNVERIFIED", snippet: "UNVERIFIED", mental_model_id: "not-a-page" })), total: ids.length });
test("page search verifies at most five unique pages concurrently and returns fresh scoped bodies in order", async () => {
    let concurrent = 0, peak = 0;
    const f = fixture(async request => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/search")) return pageHits(["a", "a", "denied", "missing", "b", "c", "overflow"]);
        const id = url.pathname.split("/").at(-1)!;
        concurrent++; peak = Math.max(peak, concurrent);
        await Bun.sleep(10); concurrent--;
        if (id === "missing") return new Response(null, { status: 404 });
        return Response.json(page({ id, name: "Current " + id, body: "Fresh " + id, tags: id === "denied" ? ["project:other"] : [] }));
    });
    const result = await f.run({ action: "page_search", query: " decision " });
    expect(result.status).toBe("ok"); expect(result.items.map(i => i.id)).toEqual(["a", "b", "c"]);
    expect(result.items.map(i => i.excerpt)).toEqual(["Fresh a", "Fresh b", "Fresh c"]);
    expect(result.items.every(i => i.synthesis === true)).toBe(true);
    expect(result.omitted_evidence).toBe(true); expect(result.truncated).toBe(true);
    for (const secret of ["UNVERIFIED", "denied", "missing", "overflow", "not-a-page"]) expect(result.raw).not.toContain(secret);
    expect(peak).toBe(5); expect(f.requests).toHaveLength(6);
    expect(new URL(f.requests[0].url).searchParams.get("tags")).toBe("project:project");
    expect(new URL(f.requests[0].url).searchParams.get("tags_match")).toBe("any");
    expect(new URL(f.requests[0].url).searchParams.get("q")).toBe("decision");
    expect(new URL(f.requests[0].url).searchParams.get("limit")).toBe("5");
});
test("page search distinguishes no hits from omitted current pages and rechecks explicit reads", async () => {
    let empty = true, denied = false;
    const f = fixture(request => new URL(request.url).pathname.endsWith("/search") ? pageHits(empty ? [] : ["page"]) : Response.json(page({ tags: denied ? ["project:other"] : [] })));
    const noHits = await f.run({ action: "page_search", query: "x" });
    expect(noHits.status).toBe("empty"); expect(noHits.omitted_evidence).not.toBe(true); expect(f.requests).toHaveLength(1);
    empty = false; expect((await f.run({ action: "page_search", query: "x" })).items[0].excerpt).toBe("Current synthesized rationale");
    denied = true; expect((await f.run({ action: "page_read", id: "page" })).status).toBe("unavailable");
    const omitted = await f.run({ action: "page_search", query: "x" });
    expect(omitted.status).toBe("empty"); expect(omitted.omitted_evidence).toBe(true);
});
test.each([{ results: null }, { results: [{}] }, { results: [{ id: ".." }] }])("malformed page search cannot become empty success: %j", async body => {
    const f = fixture(() => Response.json(body));
    expect((await f.run({ action: "page_search", query: "x" })).status).toBe("error");
    expect(f.requests).toHaveLength(1);
});
test("page verification failure aborts outstanding reads, rather than hiding schema failure", async () => {
    let started = 0, aborted = 0;
    const f = fixture(request => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/search")) return pageHits(["bad", "pending"]);
        started++;
        if (url.pathname.endsWith("/bad")) return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json(page({ id: "bad", tags: undefined }))), 20));
        return new Promise<Response>(resolve => request.signal.addEventListener("abort", () => { aborted++; resolve(Response.json(page({ id: "pending" }))); }, { once: true }));
    });
    const result = await f.run({ action: "page_search", query: "x" });
    expect(result.status).toBe("error"); expect(result.category).toBe("scope_schema"); expect(result.items).toEqual([]);
    expect(started).toBe(2);
    for (let i = 0; i < 20 && !aborted; i++) await Bun.sleep(5);
    expect(aborted).toBe(1);
});
test("page search cancellation stops all candidate reads under one deadline", async () => {
    const f = fixture(request => new URL(request.url).pathname.endsWith("/search") ? pageHits(["a", "b"]) : new Promise<Response>(resolve => request.signal.addEventListener("abort", () => resolve(Response.json(page())), { once: true })));
    const result = await f.run({ action: "page_search", query: "x" }, AbortSignal.timeout(30));
    expect(result.category).toBe("cancelled"); expect(result.items).toEqual([]); expect(f.requests).toHaveLength(3);
});

test.each(["source_search", "source_read", "page_search", "page_read"])("%s preserves complete permitted evidence in a locally readable snapshot", async action => {
    const original = "start\n" + "😀\u0001 whitespace \n".repeat(1200) + "final supporting source";
    const f = fixture(request => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/memories/recall")) return recall([
            fact("visible", [], { text: original, metadata: { title: original, token: "forbidden-metadata" } }),
            ...Array.from({ length: 6 }, (_, index) => fact("extra-" + index, [])),
            fact("forbidden-id", ["project:other"], { text: "forbidden-content" }),
        ]);
        if (url.pathname.endsWith("/search")) return pageHits(["page"]);
        if (url.pathname.includes("/knowledge-base/pages/")) return Response.json(page({ body: original, description: original }));
        return Response.json(documentRecord("doc", { original_text: original }));
    });
    const result = await f.run(action.endsWith("search") ? { action, query: "supporting source" } : { action, id: action === "source_read" ? "doc" : "page" });
    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.full_output).toMatch(/^artifact:\/\/\d+$/);
    const artifact = f.artifacts.get(String(result.full_output).slice("artifact://".length))!;
    const snapshot = JSON.parse(artifact).result;
    const field = action.endsWith("search") ? "excerpt" : "text";
    const text = snapshot.items[0][field];
    expect(decodedText(text)).toBe(original);
    if (action === "source_search") expect(decodedText(snapshot.items[0].provenance.title)).toBe(original);
    if (action.startsWith("page")) expect(decodedText(snapshot.items[0].description)).toBe(original);
    if (action === "source_search") expect(snapshot.items.map((item: TestItem) => item.id)).toEqual(["visible", ...Array.from({ length: 6 }, (_, index) => "extra-" + index)]);
    for (const excluded of ["forbidden-id", "forbidden-content", "forbidden-metadata", "UNVERIFIED", "not-a-page"]) expect(artifact).not.toContain(excluded);
    expect(Math.max(...artifact.split("\n").map(line => Buffer.byteLength(line)))).toBeLessThan(4096);
    expect(f.requests).toHaveLength(action === "page_search" ? 2 : 1);
});

function savedResult(artifacts: Map<string, string>, uri: unknown): TestEnvelope {
    expect(uri).toMatch(/^artifact:\/\/\d+$/);
    const serialized = artifacts.get(String(uri).slice("artifact://".length));
    expect(serialized).toBeDefined();
    const snapshot = JSON.parse(serialized!);
    return snapshot.result;
}

function decodedText(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    expect(value.every(chunk => typeof chunk === "string" && Array.from(chunk).length <= 512)).toBe(true);
    return value.join("");
}

function fetchedEvidence(request: Request, text: string): Response {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/memories/recall")) return recall([fact("fact", [], { text })]);
    if (url.pathname.endsWith("/search")) return pageHits(["page"]);
    if (url.pathname.includes("/knowledge-base/pages/")) return Response.json(page({ body: text }));
    return Response.json(documentRecord(decodeURIComponent(url.pathname.split("/").at(-1)!), { original_text: text }));
}

const actions = ["source_search", "source_read", "page_search", "page_read"];
const inputFor = (action: string) => action.endsWith("search") ? { action, query: "supporting source" } : { action, id: action === "source_read" ? "doc" : "page" };

test("snapshot retains every permitted supporting-fact reference beyond the preview limit", async () => {
    const ids = Array.from({ length: 8 }, (_, index) => "support-" + index);
    const supports = Object.fromEntries(ids.map(id => [id, fact(id, [], { document_id: "document-" + id })]));
    const f = fixture(() => recall([fact("observation", [], { type: "observation", source_fact_ids: [...ids, "excluded", "absent"] })], {
        ...supports, excluded: fact("excluded", ["project:other"], { text: "forbidden-support" }),
    }, { source_facts_truncated: true }));
    const result = await f.run(inputFor("source_search"));
    expect(result.items).toHaveLength(5);
    expect(result.items[0].source_fact_ids).toEqual(ids.slice(0, 5));
    const snapshot = savedResult(f.artifacts, result.full_output);
    expect(snapshot.items.map(item => item.id)).toEqual(["observation", ...ids]);
    expect(snapshot.items[0].source_fact_ids).toEqual(ids);
    expect(snapshot).toMatchObject({ source_facts_truncated: true, omitted_evidence: true, truncated: true });
    for (const forbidden of ["excluded", "absent", "forbidden-support"]) expect([...f.artifacts.values()].join("")).not.toContain(forbidden);
    expect(f.requests).toHaveLength(1);
});

test.each(["global", "per-project", "per-project-tagged"])("snapshot applies safe source scope and metadata allowlists in %s mode", async scoping => {
    values["hindsight.scoping"] = scoping;
    const original = " \ud800😀\n\u0001".repeat(200) + "tail ";
    const identity = "id-" + "\u0001".repeat(500);
    const f = fixture(() => recall([fact("allowed", [], {
        text: original, context: original, source_fact_ids: ["support", "private-support"],
        document_id: identity, metadata: { source: original, title: original, filename: original, source_id: identity, token: "PRIVATE-METADATA", url: "PRIVATE-URL" },
        raw_backend: "PRIVATE-RAW",
    }), fact("private-fact", [], { bank_id: "other", text: "PRIVATE-TEXT" }),
    ...(scoping === "per-project-tagged" ? [fact("private-tag", ["project:other"], { text: "PRIVATE-TAG" })] : [])], {
        support: fact("support", []),
        "private-support": fact("private-support", [], { bank_id: "other", text: "PRIVATE-SUPPORT" }),
    }));
    const result = await f.run(inputFor("source_search"));
    const snapshot = savedResult(f.artifacts, result.full_output);
    const item = snapshot.items[0];
    expect(snapshot.items.map(value => value.id)).toEqual(["allowed", "support"]);
    expect(item.document_id).toBe(identity);
    expect(item.source_fact_ids).toEqual(["support"]);
    expect(decodedText(item.excerpt)).toBe(original);
    expect(decodedText(item.context)).toBe(original);
    const metadata = item.provenance as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["filename", "source", "source_id", "title"]);
    expect(metadata.source_id).toBe(identity);
    for (const key of ["source", "title", "filename"]) expect(decodedText(metadata[key])).toBe(original);
    const serialized = [...f.artifacts.values()].join("");
    for (const forbidden of ["private-fact", "private-support", "private-tag", "PRIVATE-", "synthetic-token", "http://"]) expect(serialized).not.toContain(forbidden);
    expect(String(result.items[0].excerpt).isWellFormed()).toBe(true);
    expect(f.requests).toHaveLength(1);
});

test.each(["source_read", "page_read"])("%s snapshot preserves full permitted metadata without backend-only fields", async action => {
    const original = "\udfff \n😀\u0001".repeat(200) + "metadata tail";
    const f = fixture(() => Response.json(action === "source_read" ? documentRecord("doc", {
        created_at: original, updated_at: original,
        document_metadata: { title: original, filename: original, secret: "PRIVATE-METADATA" }, raw: "PRIVATE-RAW",
    }) : page({ name: original, type: original, description: original, timestamp: original, markdown: "PRIVATE-MARKDOWN", secret: "PRIVATE-RAW" })));
    const result = await f.run(inputFor(action));
    const snapshot = savedResult(f.artifacts, result.full_output);
    const item = snapshot.items[0];
    for (const key of action === "source_read" ? ["created_at", "updated_at"] : ["name", "type", "description", "timestamp"]) expect(decodedText(item[key])).toBe(original);
    if (action === "source_read") {
        const metadata = item.provenance as Record<string, unknown>;
        expect(decodedText(metadata.title)).toBe(original);
        expect(decodedText(metadata.filename)).toBe(original);
    }
    expect([...f.artifacts.values()].join("")).not.toContain("PRIVATE-");
});

test("page search snapshot contains only verified permitted bodies within the existing request budget", async () => {
    const original = "verified 😀".repeat(1000);
    const f = fixture(request => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/search")) return pageHits(["page", "denied", "missing", "a", "b", "unverified"]);
        const id = url.pathname.split("/").at(-1)!;
        if (id === "missing") return new Response("PRIVATE-MISSING", { status: 404 });
        return Response.json(page({ id, body: id === "denied" ? "PRIVATE-DENIED" : original, tags: id === "denied" ? ["project:other"] : [], markdown: "PRIVATE-MARKDOWN" }));
    });
    const result = await f.run(inputFor("page_search"));
    const snapshot = savedResult(f.artifacts, result.full_output);
    expect(snapshot.items.map(item => item.id)).toEqual(["page", "a", "b"]);
    for (const item of snapshot.items) expect(decodedText(item.excerpt)).toBe(original);
    expect(snapshot).toMatchObject({ omitted_evidence: true, truncated: true });
    const serialized = [...f.artifacts.values()].join("");
    for (const forbidden of ["denied", "missing", "unverified", "UNVERIFIED", "PRIVATE-", "not-a-page"]) expect(serialized).not.toContain(forbidden);
    expect(f.requests).toHaveLength(6);
});

test.each(actions)("%s complete and empty content has no misleading expansion link", async action => {
    let text = "complete permitted text";
    const f = fixture(request => fetchedEvidence(request, text));
    const complete = await f.run(inputFor(action));
    expect(complete.status).toBe("ok");
    expect(complete).not.toHaveProperty("full_output");
    expect(complete).not.toHaveProperty("expansion_error");
    text = "";
    const empty = await f.run(inputFor(action));
    expect(empty).not.toHaveProperty("full_output");
    expect(f.artifacts.size).toBe(0);
});

test.each(actions)("%s failures never persist evidence or expose an expansion link", async action => {
    const f = fixture(() => new Response("PRIVATE-ERROR", { status: 401 }));
    const result = await f.run(inputFor(action));
    expect(result).toMatchObject({ status: "error", items: [] });
    expect(result).not.toHaveProperty("full_output");
    expect(result).not.toHaveProperty("expansion_error");
    expect(f.artifacts.size).toBe(0);
});

test("upstream truncation and query clipping alone do not promise recoverable evidence", async () => {
    values["hindsight.recallMaxQueryChars"] = 2;
    const f = fixture(request => new URL(request.url).pathname.endsWith("/memories/recall")
        ? recall([fact("fact", [])], {}, { source_facts_truncated: true })
        : new URL(request.url).pathname.endsWith("/search") ? pageHits(["a", "b", "c", "d", "e", "not-verified"])
        : Response.json(page({ id: new URL(request.url).pathname.split("/").at(-1), body: "complete" })));
    for (const action of ["source_search", "page_search"]) {
        const result = await f.run(inputFor(action));
        expect(result).toMatchObject({ status: "ok", truncated: true, query_truncated: true });
        expect(result).not.toHaveProperty("full_output");
    }
    expect(f.artifacts.size).toBe(0);
    expect(f.requests).toHaveLength(7);
});

test.each(["source_search", "page_search"])("%s empty or denied search does not persist an empty recovery artifact", async action => {
    let denied = false;
    const f = fixture(request => {
        if (request.method === "POST") return recall(denied ? [fact("private", ["project:other"])] : []);
        if (new URL(request.url).pathname.endsWith("/search")) return pageHits(denied ? ["page"] : []);
        return Response.json(page({ tags: ["project:other"] }));
    });
    for (const excluded of [false, true]) {
        denied = excluded;
        const result = await f.run(inputFor(action));
        expect(result.status).toBe("empty");
        expect(result).not.toHaveProperty("full_output");
    }
    expect(f.artifacts.size).toBe(0);
});

test("concurrent snapshots remain distinct and unchanged by clipping or subsequent calls", async () => {
    const original = " 😀\ud800\n".repeat(2000);
    const f = fixture(request => {
        const id = new URL(request.url).pathname.split("/").at(-1)!;
        return Response.json(documentRecord(id, { original_text: original + id, document_metadata: { title: original + id } }));
    });
    const results = await Promise.all(["first", "second"].map(id => f.run({ action: "source_read", id })));
    expect(results[0].full_output).not.toBe(results[1].full_output);
    const saved = [...f.artifacts.entries()];
    for (const [index, id] of ["first", "second"].entries()) {
        const snapshot = savedResult(f.artifacts, results[index].full_output);
        expect(snapshot.items[0].id).toBe(id);
        expect(decodedText(snapshot.items[0].text)).toBe(original + id);
        expect(decodedText((snapshot.items[0].provenance as Record<string, unknown>).title)).toBe(original + id);
    }
    await f.run({ action: "source_read", id: "third" });
    for (const [id, content] of saved) expect(f.artifacts.get(id)).toBe(content);
    expect(f.artifacts.size).toBe(3);
    expect(f.requests).toHaveLength(3);
});

test.each(actions.flatMap(action => ["throws", "undefined"].map(failure => ({ action, failure }))))("$action artifact save $failure keeps bounded successful evidence with a safe explicit error", async ({ action, failure }) => {
    const f = fixture(request => fetchedEvidence(request, "😀\u0001".repeat(6000)));
    f.sessionManager.saveArtifact = async () => {
        if (failure === "throws") throw new Error("PRIVATE-STORAGE-ERROR");
        return undefined;
    };
    const result = await f.run(inputFor(action));
    expect(result).toMatchObject({ status: "ok", truncated: true, expansion_error: "artifact_unavailable" });
    expect(result.items).toHaveLength(1);
    expect(result.isError).not.toBe(true);
    expect(result).not.toHaveProperty("full_output");
    expect(result.raw).not.toContain("PRIVATE-STORAGE-ERROR");
    expect(f.artifacts.size).toBe(0);
    expect(f.requests).toHaveLength(action === "page_search" ? 2 : 1);
});
