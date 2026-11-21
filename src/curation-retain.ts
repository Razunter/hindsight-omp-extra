import { isDeepStrictEqual } from "node:util";
import { UUID, type ReplacementIds } from "./curation-attempt";

type JsonObject = Record<string, unknown>;
export type CurationRequest = (suffix: string, body?: JsonObject, method?: string) => Promise<JsonObject>;

export interface ExactReplacement {
    text: string;
    date: string;
    context: string;
    tags: string[];
    metadata: Record<string, string>;
    strategy: string;
}

const BANK_PATH = "/v1/default/banks/{bank_id}";
const VERIFY_MS = 10_000;

export async function exactRetainStrategy(read: CurationRequest, bank: string, text: string) {
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

export async function unusedReplacementDocument(read: CurationRequest, { documentId }: ReplacementIds): Promise<boolean> {
    const response = await read("/documents?" + new URLSearchParams({ q: documentId, limit: "2" }));
    return response.offset === 0 && response.limit === 2 && response.total === 0 && Array.isArray(response.items) && response.items.length === 0;
}

export async function submitReplacement(read: CurationRequest, bank: string, ids: ReplacementIds, draft: ExactReplacement): Promise<boolean> {
    try {
        const response = await read("/memories", { async: true, operation_id: ids.operationId, items: [{
            document_id: ids.documentId, content: draft.text, timestamp: draft.date || "unset", context: draft.context,
            tags: draft.tags, metadata: draft.metadata, strategy: draft.strategy, resolve_entities: false,
        }] });
        return response.bank_id === bank && response.success === true && response.async === true && response.operation_id === ids.operationId;
    } catch { return false; }
}

export async function observeReplacement(read: CurationRequest, ids: ReplacementIds, tags: string[], wait: boolean) {
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

function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
