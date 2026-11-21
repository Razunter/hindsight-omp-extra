import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BASE_LABEL, CONFIG_LABEL, CUDA_RECIPE, DERIVATIVE_LABEL, INSTALLATION_LABEL, buildCudaDerivative, candidateModelDevices, docker, dockerAvailable, inspectContainer, inspectImage, inspectUpstream, removeImage, runManagedContainer, serviceModelDevices, type ContainerInfo, type ImageInfo } from "./docker";
import { initialState, liveOperation, readState, releaseLease, takeLease, updateState, type ApprovedRuntime, type ManagementMode, type ManagementState, type UpdateCheck } from "./management-state";
import { readMentalModelSnapshot } from "./mental-model-status";
import { formatMentalModelStatus } from "./mental-model-status-view";
import { EXTENSION_ROOT, hasLegacyConfiguration, log, providerNames, resolveSettings, saveProviderSelection, savedProviderSelection, type HindsightSettings } from "./runtime-config";
import { latestStableRelease, STABLE_IMAGE } from "./stable-release";

// Reload replaces modules, not this process-lifetime startup decision.
const startupKey = Symbol.for("hindsight-omp.startup-roots");
const processState = globalThis as typeof globalThis & { [startupKey]?: Set<string> };
const startupRoots = processState[startupKey] ??= new Set<string>();

const MENU = { status: "Status", mode: "Mode", provider: "Provider configuration", apply: "Apply requested configuration", update: "Apply available update", check: "Check for updates" } as const;
const MODE_NAME: Record<ManagementMode, string> = { off: "Off", cpu: "CPU", gpu: "GPU" };
const CUDA_REPOSITORY = "hindsight-omp-cuda";
/** Hindsight's local model kinds: display name and the `<KEY>` of their `HINDSIGHT_API_<KEY>_*` settings. */
const LOCAL_MODELS = [["Embeddings", "EMBEDDINGS"], ["Reranker", "RERANKER"]] as const;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PULL_TIMEOUT_MS = 60 * 60 * 1000;
const PINNED = /@(sha256:[a-f0-9]{64})$/;
const KEEP_GPU = " GPU stays requested; no CPU fallback was applied.";

type UI = ExtensionContext["ui"];
type Outcome = { level: "info" | "warning" | "error"; message: string };
type FailureStage = NonNullable<ManagementState["failure"]>["stage"];
/**
 * The image one approval covers: already cached, downloaded from the registry by the displayed digest, or (GPU) a CUDA
 * derivative built from the upstream `base`. `reference` names the image to revalidate; `digests` are the upstream's.
 */
type Target = { reference: string; digests: string[]; base?: string } & ({ kind: "cached"; imageId: string } | { kind: "download" } | { kind: "build" });

export function registerLocalManagement(pi: ExtensionAPI): void {
    pi.registerCommand("hindsight", {
        description: "Local Hindsight management: status, Off/CPU/GPU mode, provider configuration, apply, updates and update checks",
        handler: async (_args, ctx) => {
            if (ctx.hasUI !== true) return;
            try { await openMenu(pi, ctx); }
            catch (error) { ctx.ui.notify(visible(error), "error"); }
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        // Subagents and headless sessions share the service; only an interactive root session manages it.
        if (ctx.hasUI !== true || ctx.agent.kind !== "main") return;
        const root = fs.realpathSync(EXTENSION_ROOT);
        if (startupRoots.has(root)) return;
        startupRoots.add(root);
        try { await startup(ctx.ui); }
        catch (error) { ctx.ui.notify(visible(error), "error"); }
    });
}

function visible(error: unknown): string {
    if (error instanceof Error && error.message.startsWith("Hindsight:")) return error.message;
    log("Local management failed; check Docker availability and permissions");
    return "Hindsight: local management failed; see the extension's hindsight.log";
}

function isPending(state: ManagementState, settings: HindsightSettings): boolean {
    return !state.active || state.active.provider !== settings.provider || state.active.configDigest !== settings.configDigest;
}

function matchesApproved(container: ContainerInfo, state: ManagementState): boolean {
    const active = state.active;
    return active !== undefined &&
        container.labels[INSTALLATION_LABEL] === state.installationId &&
        container.labels[CONFIG_LABEL] === active.configDigest &&
        container.imageId === active.imageId &&
        container.gpu === (active.mode === "gpu");
}

/** Local models GPU mode can accelerate: provider unset or `local`, and not forced to CPU by the owner. */
function localModels(settings: HindsightSettings): (typeof LOCAL_MODELS)[number][] {
    return LOCAL_MODELS.filter(([, key]) => [undefined, "", "local"].includes(settings.env[`HINDSIGHT_API_${key}_PROVIDER`]) &&
        !/^(true|1|yes)$/i.test(settings.env[`HINDSIGHT_API_${key}_LOCAL_FORCE_CPU`] ?? ""));
}

/** Undefined when the probe ran every local model on CUDA; otherwise what failed. */
function notOnCuda(models: (typeof LOCAL_MODELS)[number][], devices: Record<string, unknown> | undefined): string | undefined {
    if (!devices) return "its local models failed a CUDA inference check";
    for (const [model, key] of models) {
        const ran = devices[key.toLowerCase()];
        if (Array.isArray(ran) && ran.length > 0 && ran.every(device => device === "cuda")) continue;
        const where = Array.isArray(ran) && ran.length > 0 ? ran.map(device => typeof device === "string" ? device : "an undetermined device").join(", ") : "an undetermined device";
        return `its local ${model.toLowerCase()} model ran on ${where}, not CUDA`;
    }
    return undefined;
}

/** Owned by this installation and built from `base`, by any recipe version. */
function builtFor(image: ImageInfo, installationId: string, base: string): boolean {
    return image.labels[INSTALLATION_LABEL] === installationId && image.labels[DERIVATIVE_LABEL]?.startsWith("cuda") === true && image.labels[BASE_LABEL] === base;
}

/** The tag of this installation's CUDA derivative of an upstream digest, built by `recipe`. */
const derivativeTag = (digest: string, recipe: string) => `${CUDA_REPOSITORY}:${digest.slice(7, 19)}-${recipe.slice(5)}`;
const digestOf = (base: string) => base.slice(base.indexOf("@") + 1);

/**
 * After a healthy cutover, remove superseded images: owned downloads and CUDA derivatives that are neither the active
 * image, a live operation's candidate nor of the active upstream release, plus the previously active image. Everything is
 * revalidated per image just before deletion; returns the problems and the images that are no longer cached.
 */
async function removeSupersededImages(previousImage: string | undefined): Promise<{ problems: string[]; gone: string[] }> {
    const ids = new Set([...(readState()?.owned ?? []).map(entry => entry.imageId), ...(previousImage ? [previousImage] : [])]);
    const problems: string[] = [], gone: string[] = [];
    for (const id of ids) {
        const state = readState();
        const active = state?.active;
        if (!active) break;
        if (state.mode === "off") {
            problems.push("superseded images were kept because local management was turned Off");
            break;
        }
        const operation = liveOperation(state);
        const entry = state.owned?.find(owned => owned.imageId === id);
        if (id === active.imageId || id === operation?.candidateImageId) continue;
        const sameRelease = entry !== undefined && active.upstream.digests.includes(digestOf(entry.base));
        const result = await removeImage(id, image =>
            // Current-recipe images of the active release stay for reuse (GPU -> CPU -> GPU); older recipes are superseded.
            (sameRelease && (entry.kind !== "derivative" || image.labels[DERIVATIVE_LABEL] === CUDA_RECIPE)) ||
            image.tags.some(tag => entry?.kind !== "derivative" || tag !== derivativeTag(digestOf(entry.base), image.labels[DERIVATIVE_LABEL] ?? "")) ||
            image.digests.some(digest => active.upstream.digests.includes(digest)) ||
            (entry?.kind === "derivative" && !builtFor(image, state.installationId, entry.base)) ||
            (entry?.kind === "download" && !image.digests.includes(digestOf(entry.base))));
        if (result === "gone") gone.push(id);
        if (result === "failed") problems.push(`the superseded image ${id.slice(7, 19)} could not be inspected or removed`);
    }
    return { problems, gone };
}

async function startup(ui: UI): Promise<void> {
    const state = readState();
    if (!state) {
        if (!hasLegacyConfiguration()) return;
        const written = await updateState(current => current ? undefined : { ...initialState(), noticeShown: true });
        if (written) ui.notify("Hindsight: local Docker management is now opt-in and paused for this installation. Nothing was stopped or changed; open /hindsight to opt in.", "info");
        return;
    }
    if (state.mode === "off") return;
    if (!state.active) {
        ui.notify(`Hindsight: ${MODE_NAME[state.mode]} management is requested but no runtime has been approved yet; open /hindsight and apply it.`, "warning");
        return;
    }
    const { settings, error } = resolveSettings(state.mode === "gpu");
    if (!settings) {
        ui.notify(error!, "error");
        return;
    }
    const lease = await takeLease("recover");
    if (!lease) ui.notify("Hindsight: another OMP process is managing the local runtime; startup recovery skipped.", "info");
    void (async () => {
        if (lease) await runOperation(ui, lease, () => recover(settings));
        const claimed = await claimCheck(true);
        if (claimed !== undefined) await checkForUpdates(ui, settings.image, claimed, true);
    })().catch(error => ui.notify(visible(error), "error"));
}

/** Claim the shared update-check slot under the lock. Background claims honour the 24-hour interval; failed attempts count too. */
async function claimCheck(background: boolean): Promise<number | undefined> {
    const now = Date.now();
    const claimed = await updateState(state => {
        if (!state || state.mode === "off") return undefined;
        const since = now - (state.check?.attemptedAt ?? -Infinity);
        if (background && since >= 0 && since < CHECK_INTERVAL_MS) return undefined;
        return { ...state, check: { attemptedAt: now } };
    });
    return claimed && now;
}

/** Compare stable-release or explicitly configured registry digests with the approved runtime's. */
async function checkForUpdates(ui: UI, reference: string, claimed: number, background: boolean): Promise<void> {
    const stable = reference === STABLE_IMAGE;
    const release = stable ? await latestStableRelease() : undefined;
    const found = stable && !release ? undefined : await inspectUpstream(release?.image ?? reference);
    const pinned = PINNED.exec(reference)?.[1];
    const known = readState()?.active?.upstream.digests ?? [];
    let result: Omit<UpdateCheck, "attemptedAt">;
    if (found === "unsupported") {
        result = { outcome: "unsupported", message: "update checks need Docker Buildx (docker buildx imagetools), which is not available" };
    } else if (!found || (pinned && pinned !== found.digest && pinned !== found.indexDigest)) {
        log("Update check failed: the registry query failed or returned unusable metadata");
        result = { outcome: "failed", message: stable && !release
            ? "could not read stable Hindsight release metadata from GitHub; nothing was changed"
            : `could not read registry metadata for ${release?.image ?? reference}; see the extension's hindsight.log` };
    } else if (known.includes(found.digest) || (found.indexDigest !== undefined && known.includes(found.indexDigest))) {
        result = { outcome: "current" };
    } else {
        result = { outcome: "available", available: { reference, ...found, ...(release ? { release } : {}) } };
    }
    // A newer claim (another process or a later manual check) owns the record.
    const recorded = await updateState(state => state?.check?.attemptedAt === claimed ? { ...state, check: { attemptedAt: claimed, ...result } } : undefined);
    if (!recorded || (background && result.outcome === "current")) return;
    ui.notify("Hindsight: " + describeCheck({ attemptedAt: claimed, ...result }), result.outcome === "failed" || result.outcome === "unsupported" ? "warning" : "info");
}

function describeCheck(check: UpdateCheck): string {
    if (check.outcome === "current") return "the approved runtime matches the configured upstream image.";
    if (check.outcome === "available") {
        const { reference, release } = check.available!;
        const label = release ? `stable ${release.version} (${release.image})` : reference;
        return `update available for ${label}.${release ? `\n${release.url}` : ""}\nNothing was downloaded, built or changed; choose ${MENU.update} in /hindsight to review it.`;
    }
    if (check.outcome) return `update check ${check.outcome}: ${check.message}.`;
    return "update check started without a recorded result.";
}

async function checkNow(ui: UI): Promise<void> {
    const mode = readState()?.mode ?? "off";
    if (mode === "off") {
        ui.notify("Hindsight: local management is Off; choose Mode, then CPU or GPU, before checking for updates.", "warning");
        return;
    }
    const { settings, error } = resolveSettings(mode === "gpu");
    if (!settings) {
        ui.notify(error!, "error");
        return;
    }
    await startCheck(ui, settings);
}

async function startCheck(ui: UI, settings: HindsightSettings): Promise<void> {
    const claimed = await claimCheck(false);
    if (claimed === undefined) return;
    ui.notify(`Hindsight: checking ${settings.image} for updates in the background.`, "info");
    void checkForUpdates(ui, settings.image, claimed, false).catch(error => ui.notify(visible(error), "error"));
}

/** Run lifecycle work after the handler returns; the outcome is reported before the lease is released. */
async function runOperation(ui: UI, lease: string, work: () => Promise<Outcome>): Promise<void> {
    try {
        const outcome = await work().catch((error): Outcome => ({ level: "error", message: visible(error) }));
        ui.notify(outcome.message, outcome.level);
    } finally {
        await releaseLease(lease).catch(() => log("Could not release the local management lease"));
    }
}

async function recover(settings: HindsightSettings): Promise<Outcome> {
    const off: Outcome = { level: "info", message: "Hindsight: local management was turned Off; startup recovery stopped." };
    if (!await dockerAvailable()) return { level: "error", message: "Hindsight: Docker is not reachable; the managed runtime was not recovered." };
    const state = readState();
    if (!state || state.mode === "off" || !state.active) return off;
    const name = settings.containerName;
    const pending = isPending(state, settings);
    const pendingNote = " The requested configuration differs from the approved runtime and was not applied; apply it from /hindsight.";
    const container = await inspectContainer(name);
    if (container && !matchesApproved(container, state)) {
        return { level: "warning", message: `Hindsight: container ${name} is not the approved managed runtime and was left unchanged; apply the requested configuration from /hindsight to replace it.` };
    }
    if (container?.running) {
        return pending
            ? { level: "warning", message: "Hindsight: the approved runtime is running." + pendingNote }
            : { level: "info", message: `Hindsight: managed runtime running (API :${settings.apiPort}, UI :${settings.uiPort})` };
    }
    if (!container && pending) return { level: "warning", message: "Hindsight: the managed container is missing and was not recreated." + pendingNote };
    if (!container && !await inspectImage(state.active.imageId)) {
        return { level: "warning", message: `Hindsight: the approved image is no longer cached, so the missing container was not recreated; choose ${MENU.apply} in /hindsight to approve ${state.active.mode === "gpu" ? "building" : "downloading"} it again.` };
    }
    if ((readState()?.mode ?? "off") === "off") return off;
    const started = container
        ? (await docker(["start", name])).exitCode === 0
        : await runManagedContainer(settings, state.active.imageId, state.installationId);
    if (!started) {
        log("Could not start the approved runtime");
        return { level: "error", message: "Hindsight: could not start the approved runtime; see the extension's hindsight.log" };
    }
    if (pending) return { level: "warning", message: "Hindsight: started the last approved runtime." + pendingNote };
    const problem = await readinessProblem(settings);
    return problem
        ? { level: "error", message: `Hindsight: the approved runtime started but ${problem}.` }
        : { level: "info", message: `Hindsight: managed runtime ready (API :${settings.apiPort}, UI :${settings.uiPort})` };
}

/**
 * Undefined once the API and database are healthy and, in GPU mode, every applicable local model ran one inference on
 * CUDA inside the container; otherwise what failed. The inference check runs once, after the API is healthy.
 */
async function readinessProblem(settings: HindsightSettings): Promise<string | undefined> {
    const host = settings.bindAddress === "0.0.0.0" ? "127.0.0.1" : settings.bindAddress === "::" ? "::1" : settings.bindAddress;
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${settings.apiPort}/health`;
    const seconds = Number(Bun.env.HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS);
    const deadline = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
    const models = settings.gpu ? localModels(settings) : [];
    for (;;) {
        let healthy = false;
        try {
            const health = await (await fetch(url, { signal: AbortSignal.timeout(5_000) })).json();
            healthy = health?.status === "healthy" && health?.database === "connected";
        } catch {
            // Not accepting connections yet.
        }
        if (healthy) {
            if (models.length === 0) return undefined;
            const problem = notOnCuda(models, await serviceModelDevices(settings.containerName, models.map(([, key]) => key.toLowerCase())));
            return problem && `reported a healthy API and database, but ${problem}`;
        }
        if (!(await inspectContainer(settings.containerName))?.running || Date.now() >= deadline) return "did not report a healthy API and database";
        await Bun.sleep(500);
    }
}

async function openMenu(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const { ui } = ctx;
    const choice = await ui.select("Hindsight local management", Object.values(MENU));
    if (choice === MENU.status) showStatus(ui, formatMentalModelStatus(readMentalModelSnapshot(pi, ctx), "details")?.message);
    if (choice === MENU.mode) {
        const mode = await ui.select("Local Hindsight management mode", ["Off", "CPU", "GPU"]);
        if (mode === "Off") {
            await updateState(state => ({ ...(state ?? initialState()), mode: "off" }));
            ui.notify("Hindsight: local management is Off. The running container, its data and configuration were left unchanged.", "info");
        }
        if (mode === "CPU" || mode === "GPU") {
            await updateState(state => ({ ...(state ?? initialState()), mode: mode === "CPU" ? "cpu" : "gpu" }));
            await apply(ui, false);
        }
    }
    if (choice === MENU.provider) await selectProvider(ui);
    if (choice === MENU.apply) await apply(ui, false);
    if (choice === MENU.update) await apply(ui, true);
    if (choice === MENU.check) await checkNow(ui);
}

function showStatus(ui: UI, mentalModels: string | undefined): void {
    const state = readState();
    const active = state?.active;
    const lines = [
        `Requested mode: ${MODE_NAME[state?.mode ?? "off"]}`,
        `Requested provider configuration: ${savedProviderSelection() || "none"}`,
        !active ? "Last approved runtime: none"
            : active.mode === "gpu"
            ? `Last approved runtime: GPU, provider ${active.provider}, CUDA image ${active.imageId.slice(7, 19)} built from ${active.upstream.reference} (${active.upstream.digests[0]}), applied ${active.appliedAt}`
            : `Last approved runtime: CPU, provider ${active.provider}, image ${active.imageId.slice(7, 19)} from ${active.upstream.reference}, applied ${active.appliedAt}`,
    ];
    if (state && state.mode !== "off") {
        const { settings, error } = resolveSettings(state.mode === "gpu");
        lines.push(!settings ? `Pending: the requested configuration is invalid. ${error}` : isPending(state, settings) ? "Pending: the requested configuration has not been applied" : "Pending: none");
    } else {
        lines.push("Management is Off: Docker was not inspected and the service is not managed.");
    }
    if (state?.failure) lines.push(`Last failure (${MODE_NAME[state.failure.mode]} ${state.failure.stage}, ${state.failure.at}): ${state.failure.message}`);
    if (state?.cleanupFailure) lines.push(`Cleanup after the last healthy cutover failed (${state.cleanupFailure.at}): ${state.cleanupFailure.message}`);
    lines.push(state?.check ? `Last update check (${new Date(state.check.attemptedAt).toISOString()}): ${describeCheck(state.check)}` : "Last update check: none");
    const operation = state && liveOperation(state);
    if (operation) lines.push(`In progress: ${operation.kind} since ${operation.startedAt}`);
    if (mentalModels) lines.push(mentalModels);
    ui.notify(lines.join("\n"), "info");
}

async function selectProvider(ui: UI): Promise<void> {
    const names = providerNames();
    if (names.length === 0) {
        ui.notify("Hindsight: no contained provider profiles; create providers/<name>.env first", "error");
        return;
    }
    const selected = await ui.select("Hindsight provider configuration", names);
    if (selected === undefined) return;
    if (!names.includes(selected)) {
        ui.notify("Hindsight: unknown provider selection; previous choice preserved", "error");
        return;
    }
    saveProviderSelection(selected);
    if ((readState()?.mode ?? "off") !== "off") await apply(ui, false);
    else ui.notify(`Hindsight: selected ${selected}. Local management is Off, so no runtime was changed.`, "info");
}

/**
 * The image the requested configuration needs. An update targets the upstream digests the last check recorded; otherwise
 * the active runtime's upstream digests, or for a first installation the cached configured image or the checked target.
 * GPU mode reuses this installation's CUDA derivative of that base or builds one. Undefined means no target is known yet.
 */
async function planTarget(state: ManagementState, settings: HindsightSettings, update: boolean): Promise<Target | undefined> {
    const repository = settings.image.replace(PINNED, "").replace(/:[^/:]+$/, "");
    const discovered = state.check?.available;
    // Offers recorded before stable discovery have no release metadata and must be checked again.
    const available = discovered?.reference === settings.image && (settings.image !== STABLE_IMAGE || discovered.release) ? discovered : undefined;
    const offered = available ? [available.digest, ...(available.indexDigest ? [available.indexDigest] : [])] : [];
    const approved = state.active?.upstream.reference === settings.image ? state.active : undefined;
    let digests = update ? offered : approved?.upstream.digests ?? [];
    if (!update && approved && digests.length === 0) {
        const cached = !settings.gpu ? await inspectImage(approved.imageId) : undefined;
        return cached ? { kind: "cached", reference: approved.imageId, imageId: cached.id, digests } : undefined;
    }
    if (digests.length === 0 && !update) {
        const cached = settings.image === STABLE_IMAGE ? undefined : await inspectImage(settings.image);
        if (cached && !settings.gpu) return { kind: "cached", reference: settings.image, imageId: cached.id, digests: cached.digests };
        digests = cached?.digests.length ? cached.digests : offered;
    }
    if (digests.length === 0) return undefined;
    const base = `${repository}@${digests[0]}`;
    if (settings.gpu) {
        const reference = derivativeTag(digests[0], CUDA_RECIPE);
        const derivative = await inspectImage(reference);
        const reusable = derivative && builtFor(derivative, state.installationId, base) && derivative.labels[DERIVATIVE_LABEL] === CUDA_RECIPE &&
            state.owned?.some(entry => entry.kind === "derivative" && entry.imageId === derivative.id);
        return reusable ? { kind: "cached", reference, imageId: derivative.id, digests, base } : { kind: "build", reference, digests, base };
    }
    for (const digest of digests) {
        const cached = await inspectImage(`${repository}@${digest}`);
        if (cached) return { kind: "cached", reference: `${repository}@${digest}`, imageId: cached.id, digests };
    }
    return { kind: "download", reference: base, digests };
}

/** Plan the CPU or GPU runtime, ask for one approval covering preparation and cutover, then run both in the background. */
async function apply(ui: UI, update: boolean): Promise<void> {
    const state = readState();
    if (!state || state.mode === "off") {
        ui.notify("Hindsight: local management is Off; choose Mode, then CPU or GPU, first.", "warning");
        return;
    }
    const gpu = state.mode === "gpu";
    const { settings, error } = resolveSettings(gpu);
    if (!settings) {
        ui.notify(error!, "error");
        return;
    }
    const models = localModels(settings);
    if (gpu && models.length === 0) {
        ui.notify("Hindsight: GPU mode accelerates only local embedding and reranker models, and the configuration runs none on the GPU (both providers are remote or forced to CPU). Nothing was built or changed; choose CPU or configure a local model.", "error");
        return;
    }
    if (!await dockerAvailable()) {
        ui.notify("Hindsight: Docker is not reachable; nothing was changed.", "error");
        return;
    }
    const target = await planTarget(state, settings, update);
    if (!target && update) {
        ui.notify(`Hindsight: no update is recorded for ${settings.image}; choose ${MENU.check} first. Nothing was changed.`, "info");
        return;
    }
    if (!target && state.active?.upstream.reference === settings.image && state.active.upstream.digests.length === 0) {
        ui.notify(`Hindsight: the approved image has no registry digests and cannot be reused for this configuration. Choose ${MENU.check}, then ${MENU.update} to approve a version change. Nothing was changed.`, "warning");
        return;
    }
    if (!target) {
        ui.notify(`Hindsight: ${settings.image} is not cached and its registry target is not known yet; nothing was changed. When the check reports the target, choose ${MENU.apply} to approve the ${gpu ? "build" : "download"}.`, "info");
        await startCheck(ui, settings);
        return;
    }
    const container = await inspectContainer(settings.containerName);
    if (target.kind === "cached" && container?.running && !isPending(state, settings) && matchesApproved(container, state) && container.imageId === target.imageId) {
        ui.notify("Hindsight: the approved runtime already matches the requested configuration; nothing to apply.", "info");
        return;
    }
    const mode = MODE_NAME[state.mode];
    const verb = { cached: "Apply", download: "Download and apply", build: "Build and apply" }[target.kind];
    if (!await ui.confirm(`${verb} the Hindsight ${mode} runtime?`, describePlan(state, settings, target, container))) return;
    // Under the lease's lock: a choice made while the confirmation was open (Off, another mode or configuration, or a runtime
    // another process applied) voids the approval before anything is downloaded or built.
    const current = resolveSettings(gpu).settings;
    let changed: string | undefined;
    const lease = await takeLease("apply", target.kind === "cached" ? target.imageId : undefined, latest => !(changed = approvalChanged(latest, settings, current, state.active)));
    if (changed) {
        const message = abandoned(changed);
        await recordFailure(settings, "validate", message);
        ui.notify(message, "warning");
        return;
    }
    if (!lease) {
        ui.notify("Hindsight: another OMP process is changing the local runtime; nothing was applied. Try again when it finishes.", "warning");
        return;
    }
    ui.notify(target.kind === "cached"
        ? `Hindsight: applying the approved ${mode} runtime in the background.`
        : target.kind === "download"
        ? `Hindsight: preparing ${target.reference} in the background; the current service keeps running until cutover.`
        : `Hindsight: building the CUDA image from ${target.base} in the background; the current service keeps running until cutover.`, "info");
    void runOperation(ui, lease, () => applyApproved(settings, target, lease, state.installationId, state.active));
}

/**
 * Why the owner's approval of `approved` no longer covers `state`, or undefined while it does: management is Off, the mode or
 * provider configuration changed, or another process applied a runtime since the plan snapshotted `active`.
 */
function approvalChanged(state: ManagementState, approved: HindsightSettings, current: HindsightSettings | undefined, active: ApprovedRuntime | undefined): string | undefined {
    return state.mode === "off" ? "local management was turned Off"
        : state.mode !== (approved.gpu ? "gpu" : "cpu") ? "the requested mode changed after approval"
        : current?.provider !== approved.provider || current.configDigest !== approved.configDigest ? "the provider configuration changed after approval"
        : state.active?.imageId !== active?.imageId || state.active?.appliedAt !== active?.appliedAt ? "another process applied a runtime after approval"
        : undefined;
}

const abandoned = (reason: string) => `Hindsight: nothing was replaced because ${reason}; review /hindsight and apply again.`;

async function recordFailure(settings: HindsightSettings, stage: FailureStage, message: string): Promise<void> {
    await updateState(state => state && { ...state, failure: { mode: settings.gpu ? "gpu" : "cpu", provider: settings.provider, stage, message, at: new Date().toISOString() } });
}

/** The confirmation text: the image work, GPU requirements, shared-service cutover and data the approval covers. */
function describePlan(state: ManagementState, settings: HindsightSettings, target: Target, container: ContainerInfo | undefined): string {
    const models = localModels(settings);
    const runningImage = container?.imageId ?? state.active?.imageId;
    const sameRelease = state.active?.upstream.digests.some(digest => target.digests.includes(digest)) || (target.kind === "cached" && runningImage === target.imageId);
    return [
        `Hindsight provider configuration: ${settings.provider}`,
        target.kind === "download"
            ? `Image: downloads ${target.reference} for ${settings.image} in the background; the download size is not known in advance. The current service keeps running while it downloads.`
            : target.kind === "build"
            ? `Image: builds the CUDA derivative ${target.reference} from ${target.base} in the background, replacing only its PyTorch wheel with the CUDA build of the same version (about 11 GB on disk; the base is downloaded first if it is not cached). The current service keeps running during the build and GPU validation.`
            : settings.gpu
            ? `Image: reuses this installation's CUDA derivative ${target.reference} (${target.imageId.slice(7, 19)}) of ${target.base}. No download or build.`
            : `Image: ${settings.image}, cached as ${target.imageId.slice(7, 19)}. No download or build.`,
        ...(settings.gpu ? [`GPU: needs the NVIDIA driver and NVIDIA Container Toolkit. The container gets --gpus all, and the local ${models.map(([model]) => model.toLowerCase()).join(" and ")} model${models.length > 1 ? "s" : ""} must run on CUDA. Any failure keeps the current service; there is no CPU fallback.`] : []),
        container
            ? `Shared service: container ${settings.containerName} keeps running until cutover, is stopped gracefully (up to 75 seconds) and replaced.`
            : `Shared service: creates container ${settings.containerName}.`,
        `Data: reuses volume ${settings.volumeName}${settings.codexAuthDir ? " and the Codex credential directory" : ""}, the same ports, bind address and worker identity.`,
        ...(runningImage !== undefined && !sameRelease ? ["Warning: a different Hindsight version may migrate the reused database; replacing the image does not roll the database back."] : []),
    ].join("\n");
}

/** Download or build the approved target, recording images this installation created; returns the image ID or why preparation failed. */
async function prepareImage(target: Target, installationId: string): Promise<{ imageId: string } | { problem: string }> {
    const own = (imageId: string, kind: "download" | "derivative", base: string) => updateState(state => state && {
        ...state, owned: [...(state.owned ?? []).filter(owned => owned.imageId !== imageId), { imageId, kind, base, recordedAt: new Date().toISOString() }],
    });
    if (target.kind === "cached") return { imageId: target.imageId };
    if (target.kind === "download") {
        const present = await inspectImage(target.reference);
        let cached: string[] | undefined;
        if (!present) {
            // A pull can add the digest to an image that was already cached; only an image ID new to Docker is this installation's download.
            const listed = await docker(["image", "ls", "--all", "--quiet", "--no-trunc"]);
            cached = listed.exitCode === 0 ? listed.stdout.split("\n").map(line => line.trim()) : undefined;
            if ((await docker(["pull", target.reference], PULL_TIMEOUT_MS)).exitCode !== 0) {
                // Registry errors can echo credentials or tokens, so neither stdout nor stderr is logged or shown.
                log("docker pull failed for", target.reference);
                return { problem: `Hindsight: downloading ${target.reference} failed; nothing was replaced and the current service keeps running. Check Docker's registry access and apply again.` };
            }
        }
        const pulled = present ?? await inspectImage(target.reference);
        if (!pulled) return { problem: `Hindsight: ${target.reference} is not available after the download; nothing was replaced.` };
        if (cached && !cached.includes(pulled.id)) await own(pulled.id, "download", target.reference);
        return { imageId: pulled.id };
    }
    // Only GPU mode plans a build.
    if (!await buildCudaDerivative(target.base!, target.reference, installationId)) {
        log("docker build failed for", target.base);
        return { problem: `Hindsight: building the CUDA image from ${target.base} failed (base download, a CUDA PyTorch wheel for its torch version, a dependency change or the CUDA check); nothing was replaced and the current service keeps running.${KEEP_GPU} See "GPU runtime" in docs/configuration.md to rerun the build by hand.` };
    }
    const built = await inspectImage(target.reference);
    if (!built || !builtFor(built, installationId, target.base!)) return { problem: `Hindsight: ${target.reference} is not this installation's CUDA image after the build; nothing was replaced.${KEEP_GPU}` };
    await own(built.id, "derivative", target.base!);
    return { imageId: built.id };
}

async function applyApproved(settings: HindsightSettings, target: Target, lease: string, installationId: string, approvedActive: ApprovedRuntime | undefined): Promise<Outcome> {
    const mode = settings.gpu ? "gpu" : "cpu";
    const keepGpu = settings.gpu ? KEEP_GPU : "";
    const fail = async (stage: FailureStage, message: string, level: Outcome["level"] = "error"): Promise<Outcome> => {
        await recordFailure(settings, stage, message);
        return { level, message };
    };
    const prepared = await prepareImage(target, installationId);
    if ("problem" in prepared) return fail("prepare", prepared.problem);
    const { imageId } = prepared;
    const models = localModels(settings);
    const gpuProblem = settings.gpu ? notOnCuda(models, await candidateModelDevices(settings, imageId, models.map(([, key]) => key.toLowerCase()))) : undefined;
    if (gpuProblem) {
        log("GPU validation failed for", imageId);
        return fail("validate", `Hindsight: before cutover, ${gpuProblem} in a throwaway container of the CUDA image (check the NVIDIA driver, the NVIDIA Container Toolkit and docker run --gpus all); nothing was replaced and the current service keeps running.${keepGpu}`);
    }

    // Revalidate under the lock just before the first change to the shared service: the approval covers exactly this lease,
    // mode, configuration, active runtime and image. Once the old container is stopped the handoff is committed.
    const current = resolveSettings(settings.gpu).settings;
    const candidate = await inspectImage(target.reference);
    const name = settings.containerName;
    const existing = await inspectContainer(name);
    let changed: string | undefined;
    await updateState(state => {
        changed = state?.operation?.id !== lease ? "another process took over local management"
            : approvalChanged(state, settings, current, approvedActive) ?? (candidate?.id !== imageId ? "the image changed after approval" : undefined);
        if (changed) return undefined;
        return { ...state!, operation: { ...state!.operation!, candidateImageId: imageId } };
    });
    if (changed) return fail("validate", abandoned(changed), "warning");

    let previous: string | undefined;
    if (existing) {
        if (existing.running && (await docker(["stop", "--time", "75", name], 90_000)).exitCode !== 0) {
            return fail("cutover", "Hindsight: could not stop the current container gracefully; it was left in place and nothing was replaced.");
        }
        previous = `${name}-previous-${existing.id.slice(0, 12)}`;
        if ((await docker(["rename", name, previous])).exitCode !== 0) {
            if (existing.running) await docker(["start", name]);
            return fail("cutover", "Hindsight: could not set the current container aside; it was restarted and nothing was replaced.");
        }
    }
    if (!await runManagedContainer(settings, imageId, installationId)) {
        log("docker run failed during cutover");
        if (!previous) return fail("cutover", "Hindsight: the new container could not be created; see the extension's hindsight.log");
        await docker(["rm", name]);
        const restored = (await docker(["rename", previous, name])).exitCode === 0 &&
            (!existing!.running || (await docker(["start", name])).exitCode === 0);
        return fail("cutover", restored
            ? "Hindsight: the new container could not be created; the previous container was restored."
            : `Hindsight: the new container could not be created and the previous container ${previous} could not be restored; restore it manually.`);
    }
    const problem = await readinessProblem(settings);
    if (problem) {
        await docker(["stop", "--time", "75", name], 90_000);
        return fail("readiness", `Hindsight: the new container ${name} ${problem} and was stopped.` + (previous
            ? ` The previous container is preserved as ${previous} and both images are kept; the database may already have been migrated, so restoring it is a manual decision.`
            : "") + keepGpu);
    }
    let previousImage: string | undefined;
    await updateState(state => {
        if (!state) return undefined;
        previousImage = state.active?.imageId;
        const applied = state.check?.available && target.digests.includes(state.check.available.digest);
        return {
            ...state,
            active: { mode, provider: settings.provider, configDigest: settings.configDigest, upstream: { reference: settings.image, digests: target.digests }, imageId, appliedAt: new Date().toISOString() },
            failure: undefined,
            check: applied ? { attemptedAt: state.check!.attemptedAt, outcome: "current" } : state.check,
        };
    });

    const ready = `Hindsight: ${MODE_NAME[mode]} runtime ready (API :${settings.apiPort}, UI :${settings.uiPort})`;
    const problems: string[] = [];
    if (previous && (await docker(["rm", previous])).exitCode !== 0) problems.push(`the previous container ${previous} could not be removed`);
    // Moving the configured tag leaves the superseded image untagged, which is what makes it removable.
    if (target.kind === "download" && !PINNED.test(settings.image) && (await docker(["tag", imageId, settings.image])).exitCode !== 0) {
        problems.push(`${settings.image} could not be tagged to the new image`);
    }
    const superseded = await removeSupersededImages(previousImage);
    problems.push(...superseded.problems);
    const message = problems.join("; ");
    if (message) log("Cleanup after a healthy cutover failed:", message);
    // Ownership of images that are gone is dropped; a kept or failed image stays recorded for a later cleanup.
    await updateState(state => state && {
        ...state,
        owned: state.owned?.filter(entry => !superseded.gone.includes(entry.imageId)),
        cleanupFailure: message ? { message, at: new Date().toISOString() } : undefined,
    });
    return message ? { level: "warning", message: `${ready}. Cleanup needs attention: ${message}.` } : { level: "info", message: ready };
}
