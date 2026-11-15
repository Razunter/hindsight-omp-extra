import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EXTENSION_ROOT } from "./runtime-config";
import type { StableRelease } from "./stable-release";

const STATE_FILE = path.join(EXTENSION_ROOT, ".local-management.json");
const LOCK_FILE = path.join(EXTENSION_ROOT, ".local-management.lock");
/** Serializes stale-lock reclamation; held only for a read and an unlink. */
const RECLAIM_FILE = LOCK_FILE + ".reclaim";
const STALE_LOCK_MS = 60_000;
const ABANDONED_RECLAIM_MS = 10_000;

export type ManagementMode = "off" | "cpu" | "gpu";
export interface UpstreamIdentity { reference: string; digests: string[] }
/** Registry manifest digests of a discovered upstream image: `digest` is the host-platform manifest, `indexDigest` its multi-platform index. */
export interface UpstreamTarget { reference: string; digest: string; indexDigest?: string; release?: StableRelease }
/** A claimed check without an outcome is still running or was interrupted. */
export interface UpdateCheck { attemptedAt: number; outcome?: "current" | "available" | "failed" | "unsupported"; available?: UpstreamTarget; message?: string }
export interface ApprovedRuntime {
    mode: "cpu" | "gpu";
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
    failure?: { mode: "cpu" | "gpu"; provider: string; stage: "prepare" | "validate" | "cutover" | "readiness"; message: string; at: string };
    /** Housekeeping after a healthy cutover failed; the runtime itself is ready. */
    cleanupFailure?: { message: string; at: string };
    operation?: { id: string; pid: number; kind: "apply" | "recover"; startedAt: string; candidateImageId?: string };
    check?: UpdateCheck;
    /** Images this installation downloaded or built (`base` is the upstream `repo@digest`), so later cleanup never claims an image that was already cached. */
    owned?: { imageId: string; kind: "download" | "derivative"; base: string; recordedAt: string }[];
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
        if (state?.version !== 1 || typeof state.installationId !== "string" || !["off", "cpu", "gpu"].includes(state.mode)) throw new Error();
        return state;
    } catch {
        throw new Error("Hindsight: local management state is invalid; fix or remove .local-management.json");
    }
}

function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The recorded operation while its process lives; a dead holder's lease authorizes nothing. */
export function liveOperation(state: ManagementState): ManagementState["operation"] {
    return state.operation && pidAlive(state.operation.pid) ? state.operation : undefined;
}

function tokenOf(file: string): string | undefined {
    try { return fs.readFileSync(file, "utf8"); }
    catch { return undefined; }
}

/** Create `file` holding `token` unless it exists. */
function create(file: string, token: string): boolean {
    try {
        const lock = fs.openSync(file, "wx", 0o600);
        try { fs.writeSync(lock, token); }
        finally { fs.closeSync(lock); }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Hindsight: could not lock local management state; check extension-root write permissions");
        return false;
    }
}

function release(file: string, token: string): void {
    if (tokenOf(file) === token) fs.rmSync(file, { force: true });
}

/** The state lock's token while its holder is dead or it outlived any state update; undefined otherwise. */
function staleToken(): string | undefined {
    const token = tokenOf(LOCK_FILE);
    const pid = parseInt(token ?? "", 10);
    try {
        return token !== undefined && (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS || (pid > 0 && !pidAlive(pid))) ? token : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Remove the state lock if it still holds the stale `token`. Reclaimers take turns under a guard, so none can remove a lock
 * another reclaimer's successor took meanwhile. False when another live reclaimer holds the guard.
 */
function reclaim(token: string, own: string): boolean {
    if (!create(RECLAIM_FILE, own)) {
        try {
            if (Date.now() - fs.statSync(RECLAIM_FILE).mtimeMs <= ABANDONED_RECLAIM_MS) return false;
            // shortcut: a reclaimer stalled for over ten seconds between taking the mutex and unlinking could still remove a fresh lock; an OS file lock would close that window.
            fs.rmSync(RECLAIM_FILE, { force: true });
        } catch {
            // Released meanwhile.
        }
        return true;
    }
    try { if (tokenOf(LOCK_FILE) === token) fs.rmSync(LOCK_FILE, { force: true }); }
    finally { release(RECLAIM_FILE, own); }
    return true;
}

/**
 * Read-modify-write the state under the installation lock. `mutate` returns the new state to write,
 * or undefined to leave the file untouched. Never hold this across Docker work.
 */
export async function updateState(mutate: (state: ManagementState | undefined) => ManagementState | undefined): Promise<ManagementState | undefined> {
    const deadline = Date.now() + 5_000;
    const token = `${process.pid}-${randomUUID()}`;
    while (!create(LOCK_FILE, token)) {
        const stale = staleToken();
        if (stale !== undefined && reclaim(stale, token)) continue;
        if (Date.now() > deadline) throw new Error("Hindsight: local management state is locked by another process; try again");
        await Bun.sleep(20);
    }
    try {
        const next = mutate(readState());
        if (next) writeState(next);
        return next;
    } finally {
        release(LOCK_FILE, token);
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

/**
 * Take the installation-wide operation lease; undefined when another live operation holds it or `admit` refuses the state
 * under the same lock. A dead holder authorizes nothing and is cleared.
 */
export async function takeLease(kind: "apply" | "recover", candidateImageId?: string, admit: (state: ManagementState) => boolean = () => true): Promise<string | undefined> {
    const id = randomUUID();
    const taken = await updateState(state => {
        if (!state || liveOperation(state) || !admit(state)) return undefined;
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
