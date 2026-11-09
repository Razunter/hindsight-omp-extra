import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EXTENSION_ROOT } from "./runtime-config";

const STATE_FILE = path.join(EXTENSION_ROOT, ".local-management.json");
const LOCK_FILE = path.join(EXTENSION_ROOT, ".local-management.lock");
const STALE_LOCK_MS = 60_000;

export type ManagementMode = "off" | "cpu";
export interface UpstreamIdentity { reference: string; digests: string[] }
/** Registry manifest digests of a discovered upstream image: `digest` is the host-platform manifest, `indexDigest` its multi-platform index. */
export interface UpstreamTarget { reference: string; digest: string; indexDigest?: string }
/** A claimed check without an outcome is still running or was interrupted. */
export interface UpdateCheck { attemptedAt: number; outcome?: "current" | "available" | "failed" | "unsupported"; available?: UpstreamTarget; message?: string }
export interface ApprovedRuntime {
    mode: "cpu";
    provider: string;
    configDigest: string;
    upstream: UpstreamIdentity;
    imageId: string;
    appliedAt: string;
}
export interface ManagementState {
    version: 1;
    installationId: string;
    mode: ManagementMode;
    noticeShown?: boolean;
    active?: ApprovedRuntime;
    failure?: { mode: "cpu"; provider: string; stage: "prepare" | "validate" | "cutover" | "readiness"; message: string; at: string };
    /** Housekeeping after a healthy cutover failed; the runtime itself is ready. */
    cleanupFailure?: { message: string; at: string };
    operation?: { id: string; pid: number; kind: "apply" | "recover"; startedAt: string; candidateImageId?: string };
    check?: UpdateCheck;
    /** Images this installation downloaded, so later cleanup never claims an image that was already cached. */
    owned?: { imageId: string; kind: "download"; base: string; recordedAt: string }[];
}

export function initialState(): ManagementState {
    return { version: 1, installationId: randomUUID(), mode: "off" };
}

/** Persisted state, or undefined when no state file exists (management Off). */
export function readState(): ManagementState | undefined {
    let text: string;
    try { text = fs.readFileSync(STATE_FILE, "utf8"); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Hindsight: local management state is unreadable; check .local-management.json permissions");
    }
    try {
        const state = JSON.parse(text);
        if (state?.version !== 1 || typeof state.installationId !== "string" || !["off", "cpu"].includes(state.mode)) throw new Error();
        return state;
    } catch {
        throw new Error("Hindsight: local management state is invalid; fix or remove .local-management.json");
    }
}

export function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function lockIsStale(): boolean {
    try {
        const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
        return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS || (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid));
    } catch {
        return false;
    }
}

/**
 * Read-modify-write the state under the installation lock. `mutate` returns the new state to write,
 * or undefined to leave the file untouched. Never hold this across Docker work.
 */
export async function updateState(mutate: (state: ManagementState | undefined) => ManagementState | undefined): Promise<ManagementState | undefined> {
    const deadline = Date.now() + 5_000;
    for (;;) {
        try {
            const lock = fs.openSync(LOCK_FILE, "wx", 0o600);
            try { fs.writeSync(lock, String(process.pid)); }
            finally { fs.closeSync(lock); }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Hindsight: could not lock local management state; check extension-root write permissions");
            if (lockIsStale()) { fs.rmSync(LOCK_FILE, { force: true }); continue; }
            if (Date.now() > deadline) throw new Error("Hindsight: local management state is locked by another process; try again");
            await Bun.sleep(20);
        }
    }
    try {
        const next = mutate(readState());
        if (next) writeState(next);
        return next;
    } finally {
        fs.rmSync(LOCK_FILE, { force: true });
    }
}

function writeState(state: ManagementState): void {
    const temporary = STATE_FILE + "." + randomUUID();
    try {
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, STATE_FILE);
    } catch {
        throw new Error("Hindsight: could not save local management state; check extension-root write permissions");
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** Take the installation-wide operation lease; undefined when another live operation holds it. A dead holder authorizes nothing and is cleared. */
export async function takeLease(kind: "apply" | "recover", candidateImageId?: string): Promise<string | undefined> {
    const id = randomUUID();
    const taken = await updateState(state => {
        if (!state || (state.operation && pidAlive(state.operation.pid))) return undefined;
        return { ...state, operation: { id, pid: process.pid, kind, startedAt: new Date().toISOString(), ...(candidateImageId ? { candidateImageId } : {}) } };
    });
    return taken ? id : undefined;
}

export async function releaseLease(id: string): Promise<void> {
    await updateState(state => {
        if (state?.operation?.id !== id) return undefined;
        const { operation: _, ...rest } = state;
        return rest;
    });
}
