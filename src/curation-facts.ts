import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HindsightScoping } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { request, transportCategory } from "./hindsight-http";

export const CURATION_LIMIT = 5;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_LIMIT = 512;
const PROVENANCE_LIMIT = 256;
const PROVENANCE_KEYS = ["source", "session_id", "author", "project", "cwd", "project_path", "repo_root", "repository"] as const;
export type JsonObject = Record<string, unknown>;
type FactType = "world" | "experience";
type Provenance = Partial<Record<typeof PROVENANCE_KEYS[number], string>>;
type FactScope = { kind: "project"; project: string } | { kind: "global" };
export type CuratableFact = {
    id: string;
    type: FactType;
    state: "valid";
    scope: FactScope;
    text: string;
    context: string;
    date: string;
    occurred_start: string | null;
    occurred_end: string | null;
    mentioned_at: string | null;
    edited_at: string | null;
    entities: string[];
    tags: string[];
    metadata: Record<string, string>;
    document_id: string | null;
    chunk_id: string | null;
};
export interface CurationTarget {
    apiUrl: string;
    token?: string;
    bank: string;
    scoping: HindsightScoping;
    project: string;
    projectTag: string;
    cwd: string;
    root: string;
    budget: "low" | "mid" | "high";
    maxTokens: number;
    queryChars: number;
    timeout: number;
}
export interface CurationEvidence { kind: "note" | "observation"; text: string }
type SourceReference = { status: "unavailable" } | {
    status: "scoped_reference"; document_id: string; provenance: Provenance; created_at: string | null; updated_at: string | null; excerpt?: string;
};
export interface Candidate { fact: CuratableFact; source: SourceReference }

export async function investigate(target: CurationTarget, lead: CurationEvidence, signal: AbortSignal, assertCurrent: () => void) {
    const query = clip(lead.text, target.queryChars);
    const read = (suffix: string, body?: JsonObject) => {
        assertCurrent();
        return request(target, suffix, signal, body);
    };
    const recall = await read("/memories/recall", {
        query, budget: target.budget, max_tokens: target.maxTokens, types: ["world", "experience"],
        ...(target.scoping === "per-project-tagged" ? { tags: [target.projectTag], tags_match: "any" } : {}),
        rerank: { prune: false, dedup: false }, include: { entities: null, chunks: { max_tokens: 512 } },
    });
    if (!Array.isArray(recall.results)) return { response: { status: "unavailable", reason: "unsupported_recall_envelope" }, candidates: [] };
    const chunks = object(recall.chunks);
    const hits = new Map<string, JsonObject>();
    if (lead.kind === "note") {
        for (const match of lead.text.matchAll(/\bHindsight fact ([a-f0-9-]{36})\b(?: is superseded by ([a-f0-9-]{36})\b and the keeper preserves its still-useful details\.)?/gi)) {
            for (const value of [match[1], match[2]]) {
                if (value && UUID.test(value) && hits.size < CURATION_LIMIT) hits.set(value.toLowerCase(), {});
            }
            if (hits.size === CURATION_LIMIT) break;
        }
    }
    let omitted = false;
    let truncated = query.length < lead.text.length;
    for (const value of recall.results) {
        const hit = object(value);
        if (!hit || typeof hit.id !== "string" || !UUID.test(hit.id) || !isFactType(hit.type) || typeof hit.text !== "string"
            || (hit.bank_id !== undefined && hit.bank_id !== target.bank)) { omitted = true; continue; }
        if (hits.has(hit.id)) {
            if (!hits.get(hit.id)!.type) hits.set(hit.id, hit);
            continue;
        }
        if (hits.size === CURATION_LIMIT) { truncated = true; break; }
        hits.set(hit.id, hit);
    }
    const reads = await Promise.all([...hits].map(async ([id, hit]) => {
        let row: JsonObject;
        try { row = await read("/memories/" + id); }
        catch (error) { if (transportCategory(error) === "missing") return; throw error; }
        const fact = parseFact(row, target, id);
        if (!fact || (hit.type !== undefined && fact.type !== hit.type)) return;
        const source = await supportingSource(fact, target, hit, fact.chunk_id ? chunks?.[fact.chunk_id] : undefined, read);
        if (source.status === "foreign_project") return;
        const { metadata, document_id: _document, chunk_id: _chunk, ...shown } = fact;
        const candidate = { ...shown, provenance: provenance(metadata), source };
        if (Buffer.byteLength(JSON.stringify(candidate)) > 3000) return;
        return { fact, source, candidate };
    }));
    assertCurrent();
    const found = reads.filter(fact => fact !== undefined);
    return {
        response: {
            status: found.length ? "ok" : "empty", bank: target.bank, project: target.project, scoping: target.scoping,
            truncated, omitted_candidates: omitted || found.length !== reads.length, facts: found.map(item => item.candidate),
            limits: "A recall match does not prove that a fact is correct today or that two facts are duplicates. This search may miss relevant facts. Different repositories can share the same Hindsight project label.",
        },
        candidates: found.map(({ fact, source }) => ({ fact, source })),
    };
}

export function duplicateOf(target: Candidate, keeper: Candidate): boolean {
    const material = ({ id, document_id, chunk_id, edited_at, ...claim }: CuratableFact) => claim;
    const evidence = provenance(target.fact.metadata);
    if (!isDeepStrictEqual(material(target.fact), material(keeper.fact))) return false;
    const original = target.source;
    const retained = keeper.source;
    const samePassage = target.fact.document_id === keeper.fact.document_id && target.fact.chunk_id === keeper.fact.chunk_id;
    if (original.status === "scoped_reference" && retained.status === "scoped_reference") {
        if (!isDeepStrictEqual(original.provenance, retained.provenance) ||
            (!samePassage && original.excerpt !== retained.excerpt)) return false;
        if (original.provenance.source || original.provenance.session_id) return true;
    } else if (!samePassage) return false;
    return Boolean(evidence.source || evidence.session_id || evidence.author);
}

export function parseFact(row: JsonObject, target: CurationTarget, id: string): CuratableFact | undefined {
    const { type, state, text, context, date, occurred_start, occurred_end, mentioned_at, edited_at, entities, tags, document_id, chunk_id } = row;
    const metadata = object(row.metadata);
    if (row.id !== id || (row.bank_id !== undefined && row.bank_id !== target.bank) || !isFactType(type) || state !== "valid"
        || row.invalidated_at !== null || row.invalidation_reason !== null || row.observation_scopes !== null
        || typeof text !== "string" || !text.trim() || typeof context !== "string" || typeof date !== "string" || (date !== "" && !validDate(date))
        || !validDate(occurred_start) || !validDate(occurred_end) || !validDate(mentioned_at) || !validDate(edited_at)
        || !strings(entities) || !strings(tags) || !metadata || !stringMetadata(metadata)
        || (document_id !== null && !safePathId(document_id)) || (chunk_id !== null && !safePathId(chunk_id))
        || (chunk_id !== null && document_id === null) || foreignProvenance(metadata, target)) return;
    const scope = classifyScope(tags, target);
    if (!scope) return;
    return { id, type, state, scope, text, context, date, occurred_start, occurred_end, mentioned_at, edited_at, entities, tags, metadata, document_id, chunk_id };
}

export function classifyScope(tags: string[], target: CurationTarget): FactScope | undefined {
    if (new Set(tags).size !== tags.length || tags.some(tag => !safePathId(tag) || tag !== tag.trim())) return;
    const projectTags = tags.filter(tag => /^project:/i.test(tag));
    const ownTag = projectTags.length === 1 && projectTags[0] === target.projectTag;
    if (target.scoping === "global") return projectTags.length ? undefined : { kind: "global" };
    if (ownTag || (target.scoping === "per-project" && projectTags.length === 0)) return { kind: "project", project: target.project };
    if (target.scoping === "per-project-tagged" && tags.length === 0) return { kind: "global" };
}

export async function supportingSource(fact: CuratableFact, target: CurationTarget, hit: JsonObject, chunkData: unknown, read: (suffix: string) => Promise<JsonObject>) {
    if (!fact.document_id) return { status: "unavailable" } as const;
    // The list endpoint has metadata only; GET /documents/{id} contains the whole source.
    const filter = new URLSearchParams({ q: fact.document_id, limit: "5" });
    let response: JsonObject;
    try { response = await read("/documents?" + filter); }
    catch (error) {
        if (transportCategory(error)) return { status: "unavailable" } as const;
        throw error;
    }
    if (!Array.isArray(response.items) || response.items.length > 5 || response.offset !== 0 || response.limit !== 5
        || typeof response.total !== "number" || !Number.isSafeInteger(response.total) || response.total < response.items.length) return { status: "unavailable" } as const;
    const matches = response.items.map(object).filter(item => item?.id === fact.document_id);
    const doc = matches.length === 1 && matches[0];
    if (!doc || doc.bank_id !== target.bank || !strings(doc.tags) || !validDate(doc.created_at) || !validDate(doc.updated_at)
        || typeof doc.text_length !== "number" || !Number.isSafeInteger(doc.text_length) || doc.text_length < 0) return { status: "unavailable" } as const;
    const metadata = doc.document_metadata === null ? {} : object(doc.document_metadata);
    if (!metadata) return { status: "unavailable" } as const;
    if (foreignProvenance(metadata, target) || doc.tags.some(tag => /^project:/i.test(tag) && tag !== target.projectTag)) return { status: "foreign_project" } as const;
    if (PROVENANCE_KEYS.some(key => {
        const value = metadata[key];
        return typeof value === "string" && clip(value, PROVENANCE_LIMIT) !== value;
    })) return { status: "unavailable" } as const;
    const scope = classifyScope(doc.tags, target);
    if (scope?.kind !== fact.scope.kind || doc.tags.length !== fact.tags.length || !doc.tags.every(tag => fact.tags.includes(tag))) return { status: "unavailable" } as const;
    const chunk = object(chunkData);
    const matchingChunk = chunk && fact.chunk_id && hit.chunk_id === fact.chunk_id && hit.document_id === fact.document_id && chunk.id === fact.chunk_id
        && typeof chunk.chunk_index === "number" && Number.isSafeInteger(chunk.chunk_index) && chunk.chunk_index >= 0
        && typeof chunk.truncated === "boolean" && typeof chunk.text === "string" ? chunk.text : undefined;
    const excerpt = matchingChunk ? clip(matchingChunk, Math.min(480, Math.floor(doc.text_length / 2))) : "";
    return {
        status: "scoped_reference", document_id: fact.document_id, provenance: provenance(metadata),
        created_at: doc.created_at, updated_at: doc.updated_at, ...(excerpt ? { excerpt } : {}),
    } as const;
}

function foreignProvenance(metadata: JsonObject, target: CurationTarget): boolean {
    const { cwd, repo_root, project_path, project, repository } = metadata;
    for (const location of [cwd, repo_root, project_path]) {
        if (location === undefined) continue;
        if (typeof location !== "string" || !path.isAbsolute(location)) return true;
        if (![target.root, target.cwd].some(owned => path.normalize(owned) === path.normalize(location))) return true;
    }
    if (project !== undefined && (typeof project !== "string" || project.toLowerCase() !== target.project)) return true;
    // A basename alone cannot authenticate an external repository identity.
    return repository !== undefined && (typeof repository !== "string" || !path.isAbsolute(repository) || path.normalize(repository) !== path.normalize(target.root));
}

function provenance(metadata: JsonObject): Provenance {
    const fields: Provenance = {};
    for (const key of PROVENANCE_KEYS) {
        const value = metadata[key];
        if (typeof value === "string" && value.trim()) fields[key] = clip(value, PROVENANCE_LIMIT);
    }
    return fields;
}

export function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function isFactType(value: unknown): value is FactType { return value === "world" || value === "experience"; }
export function safePathId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= PATH_LIMIT && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value);
}
export function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function stringMetadata(value: JsonObject): value is Record<string, string> { return Object.values(value).every(item => typeof item === "string"); }
export function validDate(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(value) && Number.isFinite(Date.parse(value)));
}
function clip(value: string, count: number): string {
    let end = 0;
    for (const character of value) {
        if (count-- === 0) break;
        end += character.length;
    }
    return value.slice(0, end);
}
