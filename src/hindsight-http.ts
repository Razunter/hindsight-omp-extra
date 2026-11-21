const RESPONSE_BYTES = 1024 * 1024;

type RecordValue = Record<string, unknown>;
interface Target {
    apiUrl: string;
    token?: string;
    bank: string;
}

class HindsightHttpError extends Error {
    constructor(readonly category: string) { super(category); }
}

export function transportCategory(error: unknown): string | undefined {
    return error instanceof HindsightHttpError ? error.category : undefined;
}

export function isHindsightHttpUrl(url: URL): boolean {
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}

export async function request(scope: Target, suffix: string, signal: AbortSignal, body?: RecordValue, method?: string): Promise<RecordValue> {
    return requestJson(scope.apiUrl + "/v1/default/banks/" + encodeURIComponent(scope.bank) + suffix, scope.token, signal, body, method);
}

export async function requestJson(url: string, token: string | undefined, signal: AbortSignal, body?: RecordValue, method = body ? "POST" : "GET"): Promise<RecordValue> {
    const response = await fetch(url, {
        method, redirect: "error", signal,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
        // Cleanup cannot replace the classified HTTP failure.
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404) throw new HindsightHttpError("missing");
        throw new HindsightHttpError(response.status === 401 || response.status === 403 ? "authentication" : "http");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HindsightHttpError("schema");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > RESPONSE_BYTES) throw new HindsightHttpError("too_large");
            chunks.push(chunk.value);
        }
    } finally {
        // Cleanup cannot replace a response-size, abort or stream failure.
        try { await reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
    }
    const buffer = chunks.length === 1 ? chunks[0]! : new Uint8Array(bytes);
    if (chunks.length > 1) {
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
    catch { throw new HindsightHttpError("schema"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HindsightHttpError("schema");
    return value as RecordValue;
}
