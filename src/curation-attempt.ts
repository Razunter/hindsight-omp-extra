import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const ATTEMPT_ENTRY = "hindsight-curation-attempt";
export const CURATION_LIMIT = 5;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Attempt {
    id: string;
    callId: string;
    sessionId: string;
    connection: string;
    bank: string;
    scope: "project" | "global";
    project: string;
    tags: string[];
    targetIds: string[];
    keeperId: string;
}

export function findAttempt(session: ExtensionContext["sessionManager"], match: { id?: string; callId?: string }): Attempt | undefined {
    const branch = new Set(session.getBranch().map(entry => entry.id));
    const entries = session.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type !== "custom" || entry.customType !== ATTEMPT_ENTRY || !entry.data || typeof entry.data !== "object") continue;
        const value = entry.data as Partial<Attempt>;
        if (match.id !== undefined ? value.id !== match.id : value.callId !== match.callId) continue;
        if (typeof value.id !== "string" || !UUID.test(value.id) || typeof value.callId !== "string" ||
            value.sessionId !== session.getSessionId() || typeof value.connection !== "string" || !/^[0-9a-f]{64}$/.test(value.connection) ||
            typeof value.bank !== "string" || typeof value.project !== "string" || (value.scope !== "project" && value.scope !== "global") ||
            !Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === "string") ||
            !Array.isArray(value.targetIds) || !value.targetIds.length || value.targetIds.length > CURATION_LIMIT ||
            !value.targetIds.every(id => typeof id === "string" && UUID.test(id)) || new Set(value.targetIds).size !== value.targetIds.length ||
            typeof value.keeperId !== "string" || !UUID.test(value.keeperId) || value.targetIds.includes(value.keeperId)) return;
        if (!branch.has(entry.id)) {
            // OMP restore can rewind to the assistant's pending call, leaving an in-tool append on the old continuation.
            let parentId = entry.parentId;
            const seen = new Set<string>();
            let sameInvocation = false;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId);
                const parent = session.getEntry(parentId);
                if (!parent || parent.type === "reset_boundary") break;
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

export function connectionKey(sessionId: string, target: { apiUrl: string; token?: string; bank: string; scoping: string; cwd: string; root: string }): string {
    return createHash("sha256").update(JSON.stringify([sessionId, target.apiUrl, target.token, target.bank, target.scoping, target.cwd, target.root])).digest("hex");
}

export async function recordAttempt(pi: ExtensionAPI, session: ExtensionContext["sessionManager"], attempt: Attempt): Promise<boolean> {
    try {
        const path = session.getSessionFile();
        if (!path) return false;
        pi.appendEntry(ATTEMPT_ENTRY, attempt);
        const entry = session.getBranch().at(-1);
        if (entry?.type !== "custom" || entry.customType !== ATTEMPT_ENTRY || !isDeepStrictEqual(entry.data, attempt)) return false;
        await session.ensureOnDisk();
        if (session.getSessionFile() !== path) return false;
        // Local append failures can be latched without throwing. Check the exact entry on disk before an external mutation.
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
