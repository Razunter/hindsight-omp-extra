import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { computeBankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { isHindsightConfigured, loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { resolveSeedsForScope, type MentalModelSeed } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import { isHindsightHttpUrl } from "./hindsight-http";

const MODEL_STATES = ["Paused", "Stale", "Refreshing", "Current", "Unknown"] as const;
export type MentalModelState = typeof MODEL_STATES[number];
type ObservedModel = { name: string; status: MentalModelState; refreshedAt?: number | null };
export type SeedCheck = { checkedAt?: number; model?: ObservedModel | null; failed?: boolean };
interface MentalModelScope {
    target: { apiUrl: string; bank: string; token?: string };
    seeds: MentalModelSeed[];
    dir: string;
    keyPath: (seedId?: string) => string;
    timeout: number;
}

export type MentalModelSnapshot =
    | { state: "unchecked" }
    | { state: "unavailable" }
    | {
        state: "observed";
        unavailable: boolean;
        models: { model: ObservedModel; checkedAt: number }[];
        counts: Record<MentalModelState, number>;
        unchecked: number;
        latestCheck: number;
        oldestRefresh?: number;
    };

export function readMentalModelSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): MentalModelSnapshot | undefined {
    let scope: MentalModelScope | undefined;
    try { scope = resolveMentalModelScope(pi, ctx); }
    catch { return { state: "unavailable" }; }
    if (!scope) return;

    const models: { model: ObservedModel; checkedAt: number }[] = [];
    const counts = { Paused: 0, Stale: 0, Refreshing: 0, Current: 0, Unknown: 0 };
    let unavailable = false;
    let checked = 0;
    let latestCheck = 0;
    let oldestRefresh: number | undefined;
    for (const seed of scope.seeds) {
        const { checkedAt, model, failed } = readSeedCheck(scope.keyPath(seed.id) + ".json");
        unavailable ||= failed === true;
        if (checkedAt === undefined || model === undefined) continue;
        checked++;
        latestCheck = Math.max(latestCheck, checkedAt);
        if (!model) continue;
        models.push({ model, checkedAt });
        counts[model.status]++;
        if (typeof model.refreshedAt === "number") oldestRefresh = Math.min(oldestRefresh ?? Infinity, model.refreshedAt);
    }
    if (!checked) return { state: unavailable ? "unavailable" : "unchecked" };
    return { state: "observed", unavailable, models, counts, unchecked: scope.seeds.length - checked, latestCheck, oldestRefresh };
}

export function resolveMentalModelScope(pi: ExtensionAPI, ctx: ExtensionContext): MentalModelScope | undefined {
    const settings = pi.pi.settings;
    if (lookup("memory.backend")?.get(settings) !== "hindsight") return;
    const config = loadHindsightConfig(settings);
    if (!isHindsightConfigured(config) || !config.mentalModelsEnabled) return;
    // The session manager follows /move even when a timer retains its original context.
    const scope = computeBankScope(config, ctx.sessionManager.getCwd());
    const seeds = resolveSeedsForScope(scope, config.scoping);
    if (!seeds.length) return;
    const url = new URL(config.hindsightApiUrl);
    if (!isHindsightHttpUrl(url)) throw new Error("configuration");
    const apiUrl = url.href.replace(/\/+$/, "");
    const target = { apiUrl, bank: scope.bankId, token: config.hindsightApiToken ?? undefined };
    const dir = path.join(getAgentDir(), "hindsight-mental-model-monitor");
    const keyPath = (seedId?: string) => path.join(dir, createHash("sha256").update(JSON.stringify(
        seedId === undefined ? [apiUrl, scope.bankId] : [apiUrl, scope.bankId, seedId]
    )).digest("hex"));
    return { target, seeds, dir, keyPath, timeout: config.requestTimeoutMs };
}

export function readSeedCheck(record: string): SeedCheck {
    try {
        const { checkedAt, model, failed }: SeedCheck = JSON.parse(fs.readFileSync(record, "utf8"));
        if (!validDate(checkedAt) || !Number.isInteger(checkedAt) || checkedAt < 0) return { failed: failed === true };
        const validModel = model === null || (model && typeof model.name === "string"
            && MODEL_STATES.includes(model.status) && (model.refreshedAt == null || validDate(model.refreshedAt)));
        return { checkedAt, model: validModel ? model : undefined, failed: failed === true };
    } catch {
        return {};
    }
}

function validDate(value: unknown): value is number {
    return typeof value === "number" && Math.abs(value) <= 8.64e15;
}

/** The caller holds the bank lock; readers see either the old or new record. */
export function saveSeedCheck(record: string, result: SeedCheck): void {
    const temporary = record + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(temporary, record);
}
