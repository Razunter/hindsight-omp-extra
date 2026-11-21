import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURATION_LIMIT, UUID, classifyScope, object, parseFact, strings, supportingSource, validDate,
    type Candidate, type CuratableFact, type CurationEvidence, type CurationTarget, type JsonObject } from "./curation-facts";
import { confirmArchive } from "./curation-review";
import { request, requestJson, transportCategory } from "./hindsight-http";

const ATTEMPT_ENTRY = "hindsight-curation-attempt";

interface ReplacementIds { documentId: string; operationId: string }
export type Decision = "duplicate" | "superseded" | "obsolete" | "replace";

interface Attempt {
    id: string;
    callId: string;
    sessionId: string;
    connection: string;
    bank: string;
    scope: "project" | "global";
    project: string;
    tags: string[];
    targetIds: string[];
    decision: Decision;
    keeperId?: string;
    replacement?: ReplacementIds;
}

type AttemptSearch = { id: string } | { callId: string } | { replacementFor: string };

export function recoverAttempt(
    session: ExtensionContext["sessionManager"], match: AttemptSearch, target: CurationTarget | undefined,
    assertCurrent: () => void, signal?: AbortSignal,
): Promise<JsonObject> | undefined {
    const attempt = findAttempt(session, match, target);
    return attempt && reconcile(attempt, target, assertCurrent, signal);
}

export async function reviewAttempt(
    pi: ExtensionAPI, ctx: ExtensionContext, callId: string, target: CurationTarget, lead: CurationEvidence,
    plan: { originals: Candidate[]; keeper?: Candidate; decision: Decision; correction?: string }, assertCurrent: () => void, signal?: AbortSignal,
): Promise<JsonObject> {
    const { originals, decision, correction } = plan;
    let { keeper } = plan;
    const first = originals[0]!.fact;
    const session = ctx.sessionManager;
    const sessionId = session.getSessionId();
    const read = scopedRequest(target, assertCurrent, signal);
    let draft: ExactReplacement | undefined;
    if (decision === "replace") {
        const fields = exactReplacement(first, correction!);
        if (!fields) return { status: "unavailable", reason: "replacement_does_not_fit_exact_retain",
            note: "Find an active same-scope keeper preserving the fact's type and metadata. The original was not changed." };
        const capability = await exactRetainStrategy(read, target.bank, fields.text);
        assertCurrent();
        if (!capability.strategy) return { status: "unavailable", reason: capability.reason,
            note: "Could not verify that Hindsight can store the exact replacement. Find an active keeper before archiving the original." };
        draft = { ...fields, strategy: capability.strategy };
    }
    const attempt: Attempt = {
        id: randomUUID(), callId, sessionId, connection: connectionKey(sessionId, target),
        bank: target.bank, scope: first.scope.kind, project: target.project, tags: first.tags,
        targetIds: originals.map(item => item.fact.id), decision, ...(keeper ? { keeperId: keeper.fact.id } : {}),
        ...(draft ? { replacement: { documentId: `curation-${randomUUID()}`, operationId: randomUUID() } } : {}),
    };
    const action = decision === "duplicate" ? `archive ${originals.length} duplicate fact(s)`
        : decision === "obsolete" ? "archive one obsolete fact without a replacement"
        : decision === "superseded" ? "archive one fact superseded by an active keeper" : "retain an exact replacement, then archive one fact";
    const review = [
        `Action: ${action}. Bank: ${target.bank}. Scope: ${first.scope.kind}. Project: ${target.project}.`,
        `Audience tags: ${JSON.stringify(first.tags)}. Archive removes these facts from recall, including historical recall.`,
        `Evidence (${lead.kind}): ${lead.text}`,
        `Reason: ${archiveReason(attempt)}`,
        ...originals.map(item => `Archive ${item.fact.id}:\n${JSON.stringify(item, null, 2)}`),
        keeper ? `Keep active ${keeper.fact.id}:\n${JSON.stringify(keeper, null, 2)}`
            : draft ? `Exact replacement:\n${JSON.stringify(draft, null, 2)}\nDocument: ${attempt.replacement!.documentId}\nThe new fact can remain active if archive fails or is refused.`
            : "No replacement. The operator attested that this fact has no remaining use.",
    ].join("\n\n");
    const approval = await confirmArchive(ctx.ui, review, signal);
    if (approval !== "approved") return { status: "unavailable", reason: approval ?? "declined" };
    const recheck = async (candidates: Candidate[]) => {
        const snapshots = await Promise.all(candidates.map(async previous => {
            const fact = parseFact(await read("/memories/" + previous.fact.id), target, previous.fact.id);
            if (!fact || !isDeepStrictEqual(fact, previous.fact)) return false;
            const source = await supportingSource(fact, target, {}, undefined, read);
            const { excerpt, ...reviewed } = previous.source.status === "scoped_reference" ? previous.source : { ...previous.source, excerpt: undefined };
            return isDeepStrictEqual(source, reviewed);
        }));
        assertCurrent();
        return snapshots.every(Boolean);
    };
    if (draft && attempt.replacement) {
        const capability = await exactRetainStrategy(read, target.bank, draft.text);
        if (capability.strategy !== draft.strategy || !await unusedReplacementDocument(read, attempt.replacement)) {
            return { status: "unavailable", reason: "retain_capability_or_document_changed" };
        }
    }
    if (!await recheck(keeper ? [keeper, ...originals] : originals)) return { status: "unavailable", reason: "reviewed_fact_changed" };
    if (!await recordAttempt(pi, session, attempt)) return { status: "error", reason: "attempt_not_saved" };

    const summary = archiveSummary(attempt);
    let replacement: JsonObject | undefined;
    if (draft && attempt.replacement) {
        const ids = attempt.replacement;
        const acknowledged = await submitReplacement(read, target.bank, ids, draft);
        const observed = await observeReplacement(read, ids, attempt.tags, true);
        replacement = { ...observed, acknowledged };
        if (observed.state === "observed") {
            try {
                const fact = parseFact(await read("/memories/" + observed.factId), target, observed.factId);
                assertCurrent();
                if (fact && matchesReplacement(fact, draft, ids.documentId)) {
                    const source = await supportingSource(fact, target, {}, undefined, read);
                    assertCurrent();
                    if (source.status !== "foreign_project") keeper = { fact, source };
                }
            } catch { /* The replacement must be positively verified before archive. */ }
            replacement.state = keeper ? "verified" : "mismatch";
        }
        if (!keeper) {
            const original = originals[0]!.fact;
            const state = await readArchiveState(read, target, attempt, original.id, assertCurrent, original);
            summary[state].push(original.id);
            return { status: "unverified", reason: "replacement_not_verified", ...summary, replacement };
        }
        summary.keeper = keeper.fact.id;
    }
    const reason = archiveReason(attempt, summary.keeper);
    let stopped = false;
    let failure: string | undefined;
    for (const item of originals) {
        const { id } = item.fact;
        let acknowledged = false;
        if (!stopped) {
            try {
                if (!await recheck(keeper ? [keeper, item] : [item])) throw new Error("reviewed_fact_changed");
                await read("/memories/" + id, { state: "invalidated", reason }, "PATCH");
                acknowledged = true;
            } catch (error) { failure = changeReason(error); }
        }
        const state = await readArchiveState(read, target, attempt, id, assertCurrent, item.fact, summary.keeper);
        if (acknowledged && state === "observedArchived") summary.archived.push(id);
        else {
            stopped = true;
            if (state === "conflictingReason") summary.unknown.push(id);
            summary[state].push(id);
        }
    }
    const status = !stopped ? "ok" : summary.archived.length ? "partial"
        : replacement && summary.keeper && summary.unchanged.length === originals.length ? "retained_only" : "unverified";
    return { status, ...(failure ? { reason: failure } : {}), ...summary, ...(replacement ? { replacement } : {}) };
}

async function reconcile(attempt: Attempt, target: CurationTarget | undefined, assertCurrent: () => void, signal?: AbortSignal) {
    const summary = archiveSummary(attempt);
    if (!target || attempt.connection !== connectionKey(attempt.sessionId, target) || target.bank !== attempt.bank || target.project !== attempt.project ||
        classifyScope(attempt.tags, target)?.kind !== attempt.scope) {
        return { status: "unverified", reason: "scope_changed", ...summary, unknown: attempt.targetIds,
            ...(attempt.replacement ? { replacement: { ...attempt.replacement, state: "unknown" } } : {}) };
    }
    const scoped = scopedRequest(target, assertCurrent, signal);
    const read: CurationRead = suffix => scoped(suffix);
    const replacement = attempt.replacement && await observeReplacement(read, attempt.replacement, attempt.tags, false);
    let observedReplacementId: string | undefined;
    if (replacement?.state === "observed") {
        try {
            const fact = parseFact(await read("/memories/" + replacement.factId), target, replacement.factId);
            assertCurrent();
            if (fact && fact.document_id === attempt.replacement?.documentId && fact.scope.kind === attempt.scope &&
                isDeepStrictEqual(fact.tags, attempt.tags) && fact.type === "world") observedReplacementId = fact.id;
        } catch { /* Report only what was observed. */ }
    }
    const states = await Promise.all(attempt.targetIds.map(id => readArchiveState(read, target, attempt, id, assertCurrent, undefined, summary.keeper ?? observedReplacementId)));
    for (const [index, state] of states.entries()) {
        if (state === "conflictingReason") summary.unknown.push(attempt.targetIds[index]!);
        summary[state].push(attempt.targetIds[index]!);
    }
    return { status: summary.unknown.length || replacement ? "unverified" : "observed", ...summary,
        ...(replacement ? { replacement: replacement.state === "observed" ? { ...replacement, state: "observed_not_verified" } : replacement } : {}),
        note: "Readback only. An active fact may have changed since review. A replacement observed after restart has not been compared with the approved text." };
}

export function changeReason(error: unknown): string {
    return error instanceof Error && ["pass_changed", "scope_changed", "reviewed_fact_changed"].includes(error.message) ? error.message : transportCategory(error) ?? "network";
}

function findAttempt(session: ExtensionContext["sessionManager"], match: AttemptSearch, target: CurationTarget | undefined): Attempt | undefined {
    const connection = "replacementFor" in match && target ? connectionKey(session.getSessionId(), target) : undefined;
    let branch: Set<string> | undefined;
    const entries = session.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type !== "custom" || entry.customType !== ATTEMPT_ENTRY || !entry.data || typeof entry.data !== "object") continue;
        const value = entry.data as Partial<Attempt>;
        if ("id" in match ? value.id !== match.id : "callId" in match ? value.callId !== match.callId :
            value.decision !== "replace" || value.connection !== connection || !Array.isArray(value.targetIds) || !value.targetIds.includes(match.replacementFor)) continue;
        if (typeof value.id !== "string" || !UUID.test(value.id) || typeof value.callId !== "string" ||
            value.sessionId !== session.getSessionId() || typeof value.connection !== "string" || !/^[0-9a-f]{64}$/.test(value.connection) ||
            typeof value.bank !== "string" || typeof value.project !== "string" || (value.scope !== "project" && value.scope !== "global") ||
            !strings(value.tags) ||
            !Array.isArray(value.targetIds) || !value.targetIds.length || value.targetIds.length > CURATION_LIMIT ||
            !value.targetIds.every(id => typeof id === "string" && UUID.test(id)) || new Set(value.targetIds).size !== value.targetIds.length ||
            !["duplicate", "superseded", "obsolete", "replace"].includes(value.decision as string) ||
            (value.decision === "duplicate" || value.decision === "superseded"
                ? typeof value.keeperId !== "string" || !UUID.test(value.keeperId) || value.targetIds.includes(value.keeperId) || value.replacement !== undefined
                : value.keeperId !== undefined || value.targetIds.length !== 1 ||
                    (value.decision === "replace" ? !value.replacement || typeof value.replacement.documentId !== "string" ||
                        !/^curation-[0-9a-f-]{36}$/.test(value.replacement.documentId) ||
                        typeof value.replacement.operationId !== "string" || !UUID.test(value.replacement.operationId) : value.replacement !== undefined))) return;
        branch ??= new Set(session.getBranch().map(entry => entry.id));
        if (!branch.has(entry.id)) {
            // OMP restore can rewind to the assistant's pending call, leaving an in-tool append on the old continuation.
            let parentId = entry.parentId;
            const seen = new Set<string>();
            let sameInvocation = false;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId);
                const parent = session.getEntry(parentId);
                if (!parent || parent.type === "reset_boundary") break;
                if (parent.type === "message" && parent.message.role === "toolResult") {
                    parentId = parent.parentId;
                    continue;
                }
                if (parent.type === "message") {
                    sameInvocation = branch.has(parent.id) && parent.message.role === "assistant" &&
                        parent.message.content.some(part => part.type === "toolCall" && part.id === value.callId && part.name === "hindsight_curate");
                    break;
                }
                parentId = parent.parentId;
            }
            if (!sameInvocation) continue;
        }
        return value as Attempt;
    }
}

function connectionKey(sessionId: string, target: CurationTarget): string {
    return createHash("sha256").update(JSON.stringify([sessionId, target.apiUrl, target.token, target.bank, target.scoping, target.cwd, target.root])).digest("hex");
}

async function recordAttempt(pi: ExtensionAPI, session: ExtensionContext["sessionManager"], attempt: Attempt): Promise<boolean> {
    try {
        const path = session.getSessionFile();
        if (!path) return false;
        pi.appendEntry(ATTEMPT_ENTRY, attempt);
        const entry = session.getBranch().at(-1);
        if (entry?.type !== "custom" || entry.customType !== ATTEMPT_ENTRY || !isDeepStrictEqual(entry.data, attempt)) return false;
        await session.ensureOnDisk();
        if (session.getSessionFile() !== path) return false;
        // OMP can record an append failure without throwing. Check the exact session entry on disk before writing to Hindsight.
        const file = Bun.file(path);
        const tail = await file.slice(Math.max(0, file.size - 65_536)).text();
        for (const line of tail.split("\n")) {
            if (!line.includes(attempt.id)) continue;
            const saved = JSON.parse(line);
            if (saved.type === "custom" && saved.id === entry.id && saved.customType === ATTEMPT_ENTRY && isDeepStrictEqual(saved.data, attempt)) return true;
        }
    } catch { return false; }
    return false;
}

function archiveReason(attempt: Attempt, keeperId = attempt.keeperId): string {
    const explanation = attempt.decision === "duplicate" ? `Duplicate of ${keeperId}; same claim, scope and material metadata.`
        : attempt.decision === "obsolete" ? "The operator confirmed the fact is obsolete and has no remaining use, including as history."
        : `Superseded by ${keeperId ?? `the verified fact from document ${attempt.replacement!.documentId}`}; first-hand correction preserving useful details.`;
    return `${explanation} Curation attempt ${attempt.id}.`;
}

function archiveSummary(attempt: Attempt) {
    return { bank: attempt.bank, scope: attempt.scope === "project" ? { kind: "project", project: attempt.project } : { kind: "global" },
        attempt: attempt.id, keeper: attempt.keeperId, archived: [] as string[], observedArchived: [] as string[],
        unchanged: [] as string[], observedActive: [] as string[], unknown: [] as string[], conflictingReason: [] as string[] };
}

async function readArchiveState(
    read: CurationRead, target: CurationTarget, attempt: Attempt, id: string, assertCurrent: () => void, expected?: CuratableFact, keeperId = attempt.keeperId,
): Promise<"unchanged" | "observedActive" | "observedArchived" | "unknown" | "conflictingReason"> {
    try {
        const actual = await read("/memories/" + id);
        assertCurrent();
        const archived = actual.state === "invalidated" && typeof actual.invalidated_at === "string" && validDate(actual.invalidated_at);
        const fact = parseFact(archived ? { ...actual, state: "valid", invalidation_reason: null, invalidated_at: null } : actual, target, id);
        if (!fact || fact.scope.kind !== attempt.scope || !isDeepStrictEqual(fact.tags, attempt.tags) ||
            (expected && !isDeepStrictEqual(fact, expected))) return "unknown";
        if (!archived) return expected ? "unchanged" : "observedActive";
        if (attempt.replacement && !keeperId) return "unknown";
        return actual.invalidation_reason === archiveReason(attempt, keeperId) ? "observedArchived" : "conflictingReason";
    } catch { return "unknown"; }
}

function scopedRequest(target: CurationTarget, assertCurrent: () => void, signal?: AbortSignal): CurationRequest {
    return (suffix, body, method) => {
        assertCurrent();
        const deadline = AbortSignal.timeout(target.timeout);
        const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
        return suffix === "/openapi.json" ? requestJson(target.apiUrl + suffix, target.token, requestSignal) : request(target, suffix, requestSignal, body, method);
    };
}

type CurationRead = (suffix: string) => Promise<JsonObject>;
type CurationRequest = (suffix: string, body?: JsonObject, method?: string) => Promise<JsonObject>;

interface ExactReplacement {
    text: string;
    date: string;
    context: string;
    tags: string[];
    metadata: Record<string, string>;
    strategy: string;
}

const BANK_PATH = "/v1/default/banks/{bank_id}";
const VERIFY_MS = 10_000;

function exactReplacement(fact: CuratableFact, text: string) {
    if (fact.type !== "world" || fact.occurred_start !== null || fact.occurred_end !== null || fact.entities.length ||
        fact.mentioned_at !== (fact.date || null) || !text.trim() || text !== text.trim() || Buffer.byteLength(text) > 3_000 ||
        /[\p{C}\p{Zl}\p{Zp}]|⟦hs-att:/u.test(text)) return;
    return { type: "world", text, date: fact.date, context: fact.context, tags: fact.tags, metadata: fact.metadata };
}

function matchesReplacement(fact: CuratableFact, draft: ExactReplacement, documentId: string) {
    return fact.document_id === documentId && fact.type === "world" && fact.text === draft.text && fact.context === draft.context &&
        fact.date === draft.date && fact.mentioned_at === (draft.date || null) && fact.occurred_start === null && fact.occurred_end === null &&
        fact.entities.length === 0 && isDeepStrictEqual(fact.tags, draft.tags) && isDeepStrictEqual(fact.metadata, draft.metadata);
}

async function exactRetainStrategy(read: CurationRead, bank: string, text: string) {
    try {
        const schema = await read("/openapi.json");
        const paths = object(schema.paths);
        const memory = object(paths?.[BANK_PATH + "/memories/{memory_id}"]);
        if (!object(memory?.get) || !object(memory?.patch)) return { reason: "archive_capability_unverified" } as const;
        const schemas = object(object(schema.components)?.schemas);
        const retain = object(object(schemas?.RetainRequest)?.properties);
        const item = object(object(schemas?.MemoryItem)?.properties);
        if (!object(object(paths?.[BANK_PATH + "/memories"])?.post) || !object(object(paths?.[BANK_PATH + "/memories/list"])?.get)
            || !object(object(paths?.[BANK_PATH + "/operations/{operation_id}"])?.get) || !retain?.operation_id || !retain.async || !item?.strategy) {
            return { reason: "exact_retain_capability_unverified" } as const;
        }
        const response = await read("/config");
        const config = object(response.config);
        const strategies = object(config?.retain_strategies);
        if (response.bank_id === bank && strategies) {
            for (const name of Object.keys(strategies).sort()) {
                const strategy = object(strategies[name]);
                const size = strategy?.retain_chunk_size ?? config?.retain_chunk_size;
                if (name && name.length <= 128 && strategy?.retain_extraction_mode === "chunks" && typeof size === "number" &&
                    Number.isSafeInteger(size) && text.length <= size) return { strategy: name } as const;
            }
        }
        return { reason: "no_compatible_chunks_strategy" } as const;
    } catch { return { reason: "retain_capability_unverified" } as const; }
}

async function unusedReplacementDocument(read: CurationRead, { documentId }: ReplacementIds): Promise<boolean> {
    const response = await read("/documents?" + new URLSearchParams({ q: documentId, limit: "2" }));
    return response.offset === 0 && response.limit === 2 && response.total === 0 && Array.isArray(response.items) && response.items.length === 0;
}

async function submitReplacement(send: CurationRequest, bank: string, ids: ReplacementIds, draft: ExactReplacement): Promise<boolean> {
    try {
        const response = await send("/memories", { async: true, operation_id: ids.operationId, items: [{
            document_id: ids.documentId, content: draft.text, timestamp: draft.date || "unset", context: draft.context,
            tags: draft.tags, metadata: draft.metadata, strategy: draft.strategy, resolve_entities: false,
        }] });
        return response.bank_id === bank && response.success === true && response.async === true && response.operation_id === ids.operationId;
    } catch { return false; }
}

async function observeReplacement(read: CurationRead, ids: ReplacementIds, tags: string[], wait: boolean) {
    let operation = "unknown";
    const deadline = Date.now() + VERIFY_MS;
    try {
        for (;;) {
            const result = await read("/operations/" + ids.operationId);
            if (result.operation_id !== ids.operationId || result.operation_type !== "batch_retain") break;
            const metadata = object(result.result_metadata);
            if (metadata?.document_id !== undefined && metadata.document_id !== ids.documentId) break;
            if (["pending", "processing", "completed", "failed", "cancelled"].includes(String(result.status))) operation = String(result.status);
            if (operation === "completed" && typeof metadata?.extraction_errors_count === "number" && metadata.extraction_errors_count !== 0) operation = "unverified";
            if (!wait || (operation !== "pending" && operation !== "processing") || Date.now() >= deadline) break;
            await Bun.sleep(200);
        }
    } catch { operation = "unknown"; }
    const scope = { ...ids, operation, factIds: [] as string[] };
    try {
        // The default list hides archived rows, but the document must contain exactly one fact and it must be active.
        const [active, archived] = await Promise.all((["valid", "invalidated"] as const).map(async state => {
            const response = await read("/memories/list?" + new URLSearchParams({ document_id: ids.documentId, state, limit: "2" }));
            const { offset, limit, total, items } = response;
            if (offset !== 0 || limit !== 2 || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
                !Array.isArray(items) || items.length !== Math.min(total, 2)) throw new Error("replacement_list_unverified");
            const found = items.map(object).filter((row): row is JsonObject => Boolean(row && row.document_id === ids.documentId &&
                row.state === state && typeof row.id === "string" && UUID.test(row.id) && isDeepStrictEqual(row.tags, tags)));
            return { total, found };
        }));
        scope.factIds = [...active.found, ...archived.found].map(row => row.id as string);
        if (active.total === 0 && archived.total === 0) return { ...scope, state: "missing" } as const;
        if (active.total + archived.total !== 1 || archived.total !== 0) return { ...scope, state: "not_one_active_fact" } as const;
        if (operation !== "completed" || active.found.length !== 1) return { ...scope, state: "unverified" } as const;
        return { ...scope, state: "observed", factId: active.found[0]!.id as string } as const;
    } catch { return { ...scope, state: "unverified" } as const; }
}
