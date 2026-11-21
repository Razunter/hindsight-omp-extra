import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { seedAlreadyExists, type MentalModelSeed } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import { tryAcquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { request } from "./hindsight-http";
import { readMentalModelSnapshot, readSeedCheck, resolveMentalModelScope, saveSeedCheck, type MentalModelState, type SeedCheck } from "./mental-model-status";
import { formatMentalModelStatus, plainStatusLabel } from "./mental-model-status-view";
import { log } from "./runtime-config";

type Model = { id: string; name: string; tags?: string[]; is_stale?: boolean | null; last_refresh_failed_at?: string | null; last_refreshed_at?: unknown };
type Finding = { status: "Paused" | "Stale"; name: string };
type DueSeed = { seed: MentalModelSeed; file: string; previous: SeedCheck };
type ReadPage = (suffix: string) => Promise<Record<string, unknown>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CADENCE_MS = 24 * HOUR_MS;
const PAGE_CAP = 20;

class CheckError extends Error {
    constructor(readonly category: string) { super(category); }
}

export function registerMentalModelMonitor(pi: ExtensionAPI): void {
    let current: ExtensionContext | undefined;
    pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI !== true || ctx.agent.kind !== "main") return;
        if (current) {
            current = ctx;
            return;
        }
        current = ctx;
        const display = formatMentalModelStatus(readMentalModelSnapshot(pi, ctx), "summary");
        if (display) ctx.ui.notify(display.message, display.warning ? "warning" : "info");
        const tick = () => check(pi, current ?? ctx);
        ctx.setTimeout(tick, MINUTE_MS);
        ctx.setInterval(tick, HOUR_MS);
    });
}

async function check(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    let phase = "configuration";
    let failure: string | undefined;
    let lock: FileLockHandle | null | undefined;
    let due: DueSeed[] = [];
    try {
        const scope = resolveMentalModelScope(pi, ctx);
        if (!scope) return;
        const { target, seeds, dir, keyPath, timeout } = scope;
        if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("configuration");

        phase = "storage";
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // OMP names the lock after the path string, so every alias of one profile must resolve to one path.
        const lockPath = path.join(fs.realpathSync(dir), path.basename(keyPath()));
        // One lock per bank, held for the whole check, so concurrent sessions cannot split one bank's findings across two warnings.
        lock = tryAcquireFileLock(lockPath);
        if (!lock) return;
        due = seeds.map(seed => {
            const file = keyPath(seed.id) + ".json";
            return { seed, file, previous: readSeedCheck(file) };
        }).filter(({ previous }) => !recent(previous.checkedAt));
        if (!due.length) return;

        phase = "request";
        const readPage: ReadPage = async suffix => {
            const signal = AbortSignal.timeout(timeout);
            try { return await request(target, suffix, signal); }
            catch (error) {
                const category = error instanceof Error && "category" in error && typeof error.category === "string" ? error.category : "network";
                throw new CheckError(signal.aborted ? "deadline" : category);
            }
        };
        const models = new Map<string, Model>();
        await pages(readPage, "/mental-models?detail=metadata&exclude_knowledge_pages=true&limit=1000", "items", 1000, value => {
            if (!isModel(value) || models.has(value.id)) throw new CheckError("schema");
            models.set(value.id, value);
        });
        const matched = due.map(({ seed }) => {
            let model = models.get(seed.id);
            for (const id of seed.legacyIds ?? []) {
                if (model) break;
                const candidate = models.get(id);
                if (candidate && seedAlreadyExists(seed, [{ ...candidate, bank_id: target.bank }])) model = candidate;
            }
            return model;
        });
        const retrying = matched.some(model => model && finding(status(model))) ? await listRetries(readPage) : undefined;
        const findings: Finding[] = [];
        const observed = matched.map(model => {
            if (!model) return null;
            const state = status(model, retrying);
            const name = model.name || model.id;
            if (finding(state)) findings.push({ status: state, name });
            const timestamp = typeof model.last_refreshed_at === "string" ? Date.parse(model.last_refreshed_at) : NaN;
            const refreshedAt = model.last_refreshed_at === null ? null : Number.isFinite(timestamp) ? timestamp : undefined;
            return { status: state, name, refreshedAt };
        });

        // A warning already shown is better repeated than lost to a failed record write.
        phase = "notification";
        if (findings.length) notify(ctx, target.bank, findings);
        phase = "storage";
        const checkedAt = Date.now();
        for (const [index, { file }] of due.entries()) saveSeedCheck(file, { checkedAt, model: observed[index] });
    } catch (error) {
        failure = error instanceof CheckError ? error.category : phase;
        if (phase === "request") {
            try {
                for (const { file, previous } of due) saveSeedCheck(file, { ...previous, failed: true });
            } catch {
                log("Could not save mental model check availability");
            }
        }
    } finally {
        lock?.release();
        if (failure) log("Mental model check failed:", failure);
    }
}

function status(model: Model, retrying?: ReadonlySet<string>): MentalModelState {
    if (retrying?.has(model.id)) return "Refreshing";
    if (model.last_refresh_failed_at) return "Paused";
    if (model.is_stale === true) return "Stale";
    return model.is_stale === false ? "Current" : "Unknown";
}

function finding(status: MentalModelState): status is Finding["status"] {
    return status === "Paused" || status === "Stale";
}

function isModel(value: unknown): value is Model {
    if (typeof value !== "object" || value === null) return false;
    const model = value as Record<string, unknown>;
    return typeof model.id === "string" && model.id.length > 0 && typeof model.name === "string"
        && (model.tags === undefined || (Array.isArray(model.tags) && model.tags.every(tag => typeof tag === "string")))
        && (model.is_stale == null || typeof model.is_stale === "boolean")
        && (model.last_refresh_failed_at == null || typeof model.last_refresh_failed_at === "string");
}

async function pages(readPage: ReadPage, route: string, field: "items" | "operations", requestedLimit: number, visit: (value: unknown) => void): Promise<void> {
    let offset = 0;
    let total: number | undefined;
    for (let index = 0; index < PAGE_CAP; index++) {
        const body = await readPage(`${route}&offset=${offset}`);
        const records = body[field];
        const { limit } = body;
        if (!isCount(body.total) || !Array.isArray(records) || body.offset !== offset || !isCount(limit) || limit < 1 || limit > requestedLimit) throw new CheckError("schema");
        total ??= body.total;
        const end = offset + records.length;
        if (body.total !== total || end > total || records.length > limit || (!records.length && end < total)) throw new CheckError("pagination");
        for (const value of records) visit(value);
        if (end === total) return;
        offset = end;
    }
    throw new CheckError("pagination");
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function listRetries(readPage: ReadPage): Promise<Set<string>> {
    const retrying = new Set<string>();
    // Pending first: a refresh that starts processing between the two reads still shows up in the second.
    for (const status of ["pending", "processing"]) {
        await pages(readPage, `/operations?type=refresh_mental_model&status=${status}&limit=100`, "operations", 100, value => {
            if (typeof value !== "object" || value === null) throw new CheckError("schema");
            const operation = value as Record<string, unknown>;
            if (typeof operation.mental_model_id !== "string" || !operation.mental_model_id || typeof operation.status !== "string") throw new CheckError("schema");
            if (operation.status === "pending" || operation.status === "processing") retrying.add(operation.mental_model_id);
        });
    }
    return retrying;
}

function notify(ctx: ExtensionContext, bank: string, findings: Finding[]): void {
    const paused: string[] = [], stale: string[] = [];
    for (const finding of findings) (finding.status === "Paused" ? paused : stale).push(plainStatusLabel(finding.name));
    const lines = [`Hindsight mental models in bank ${plainStatusLabel(bank)}`];
    if (paused.length) lines.push(`Paused: ${paused.join(", ")}. The last refresh failed. Automatic refresh waits until a refresh succeeds.`);
    if (stale.length) lines.push(`Stale: ${stale.join(", ")}. Newer memories exist since the last refresh.`);
    lines.push("You can refresh these models in the Hindsight Control Plane.");
    ctx.ui.notify(lines.join("\n"), "warning");
}

function recent(checkedAt: number | undefined): boolean {
    if (checkedAt === undefined) return false;
    const age = Date.now() - checkedAt;
    return age >= 0 && age < CADENCE_MS;
}
