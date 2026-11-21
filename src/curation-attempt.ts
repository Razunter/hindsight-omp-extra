import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const ATTEMPT_ENTRY = "hindsight-curation-attempt";

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
