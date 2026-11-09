import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_LABEL, INSTALLATION_LABEL, docker, dockerAvailable, inspectContainer, inspectImage, runManagedContainer, type ContainerInfo } from "./docker";
import { initialState, pidAlive, readState, releaseLease, takeLease, updateState, type ManagementState } from "./management-state";
import { EXTENSION_ROOT, hasLegacyConfiguration, log, providerNames, resolveSettings, saveProviderSelection, savedProviderSelection, type HindsightSettings } from "./runtime-config";

// Reload replaces modules, not this process-lifetime startup decision.
const startupKey = Symbol.for("hindsight-omp.startup-roots");
const processState = globalThis as typeof globalThis & { [startupKey]?: Set<string> };
const startupRoots = processState[startupKey] ??= new Set<string>();

const MENU = { status: "Status", mode: "Mode", provider: "Provider configuration", apply: "Apply requested configuration" } as const;

type UI = ExtensionContext["ui"];
type Outcome = { level: "info" | "warning" | "error"; message: string };
type FailureStage = NonNullable<ManagementState["failure"]>["stage"];
interface ApprovedPlan { settings: HindsightSettings; imageId: string; digests: string[] }

export function registerLocalManagement(pi: ExtensionAPI): void {
    pi.registerCommand("hindsight", {
        description: "Local Hindsight management: status, Off/CPU mode, provider configuration and apply",
        handler: async (_args, ctx) => {
            if (ctx.hasUI !== true) return;
            try { await openMenu(ctx.ui); }
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
        container.imageId === active.imageId;
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
        ui.notify("Hindsight: CPU management is requested but no runtime has been approved yet; open /hindsight and apply it.", "warning");
        return;
    }
    const { settings, error } = resolveSettings();
    if (!settings) {
        ui.notify(error!, "error");
        return;
    }
    const lease = await takeLease("recover");
    if (!lease) {
        ui.notify("Hindsight: another OMP process is managing the local runtime; startup recovery skipped.", "info");
        return;
    }
    void runOperation(ui, lease, () => recover(settings));
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
    if (state?.mode !== "cpu" || !state.active) return off;
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
        return { level: "warning", message: "Hindsight: the approved image is no longer cached, so the missing container was not recreated; restoring it requires an explicit download." };
    }
    if (readState()?.mode !== "cpu") return off;
    const started = container
        ? (await docker(["start", name])).exitCode === 0
        : await runManagedContainer(settings, state.active.imageId, state.installationId);
    if (!started) {
        log("Could not start the approved runtime");
        return { level: "error", message: "Hindsight: could not start the approved runtime; see the extension's hindsight.log" };
    }
    if (pending) return { level: "warning", message: "Hindsight: started the last approved runtime." + pendingNote };
    return await waitUntilReady(settings)
        ? { level: "info", message: `Hindsight: managed runtime ready (API :${settings.apiPort}, UI :${settings.uiPort})` }
        : { level: "error", message: "Hindsight: the approved runtime started but did not report a healthy API and database." };
}

async function waitUntilReady(settings: HindsightSettings): Promise<boolean> {
    const host = settings.bindAddress === "0.0.0.0" ? "127.0.0.1" : settings.bindAddress === "::" ? "::1" : settings.bindAddress;
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${settings.apiPort}/health`;
    const seconds = Number(Bun.env.HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS);
    const deadline = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
    for (;;) {
        try {
            const health = await (await fetch(url, { signal: AbortSignal.timeout(5_000) })).json();
            if (health?.status === "healthy" && health?.database === "connected") return true;
        } catch {
            // Not accepting connections yet.
        }
        if (!(await inspectContainer(settings.containerName))?.running || Date.now() >= deadline) return false;
        await Bun.sleep(500);
    }
}

async function openMenu(ui: UI): Promise<void> {
    const choice = await ui.select("Hindsight local management", Object.values(MENU));
    if (choice === MENU.status) showStatus(ui);
    if (choice === MENU.mode) {
        const mode = await ui.select("Local Hindsight management mode", ["Off", "CPU"]);
        if (mode === "Off") {
            await updateState(state => ({ ...(state ?? initialState()), mode: "off" }));
            ui.notify("Hindsight: local management is Off. The running container, its data and configuration were left unchanged.", "info");
        }
        if (mode === "CPU") {
            await updateState(state => ({ ...(state ?? initialState()), mode: "cpu" }));
            await apply(ui);
        }
    }
    if (choice === MENU.provider) await selectProvider(ui);
    if (choice === MENU.apply) await apply(ui);
}

function showStatus(ui: UI): void {
    const state = readState();
    const active = state?.active;
    const lines = [
        `Requested mode: ${state?.mode === "cpu" ? "CPU" : "Off"}`,
        `Requested provider configuration: ${savedProviderSelection() || "none"}`,
        active
            ? `Last approved runtime: CPU, provider ${active.provider}, image ${active.imageId.slice(7, 19)} from ${active.upstream.reference}, applied ${active.appliedAt}`
            : "Last approved runtime: none",
    ];
    if (state?.mode === "cpu") {
        const { settings, error } = resolveSettings();
        lines.push(!settings ? `Pending: the requested configuration is invalid. ${error}` : isPending(state, settings) ? "Pending: the requested configuration has not been applied" : "Pending: none");
    } else {
        lines.push("Management is Off: Docker was not inspected and the service is not managed.");
    }
    if (state?.failure) lines.push(`Last failure (${state.failure.stage}, ${state.failure.at}): ${state.failure.message}`);
    if (state?.operation && pidAlive(state.operation.pid)) lines.push(`In progress: ${state.operation.kind} since ${state.operation.startedAt}`);
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
    if (readState()?.mode === "cpu") await apply(ui);
    else ui.notify(`Hindsight: selected ${selected}. Local management is Off, so no runtime was changed.`, "info");
}

/** Plan the cached CPU runtime, ask for one approval, then cut over in the background. */
async function apply(ui: UI): Promise<void> {
    const state = readState();
    if (state?.mode !== "cpu") {
        ui.notify("Hindsight: local management is Off; choose Mode, then CPU, first.", "warning");
        return;
    }
    const { settings, error } = resolveSettings();
    if (!settings) {
        ui.notify(error!, "error");
        return;
    }
    if (!await dockerAvailable()) {
        ui.notify("Hindsight: Docker is not reachable; nothing was changed.", "error");
        return;
    }
    const image = await inspectImage(settings.image);
    if (!image) {
        ui.notify(`Hindsight: ${settings.image} is not cached locally. Downloading it requires an explicit download action; nothing was changed.`, "warning");
        return;
    }
    const name = settings.containerName;
    const container = await inspectContainer(name);
    if (container?.running && !isPending(state, settings) && matchesApproved(container, state) && container.imageId === image.id) {
        ui.notify("Hindsight: the approved runtime already matches the requested configuration; nothing to apply.", "info");
        return;
    }
    const previousImage = container?.imageId ?? state.active?.imageId;
    const plan = [
        `Hindsight provider configuration: ${settings.provider}`,
        `Image: ${settings.image}, cached as ${image.id.slice(7, 19)}. No download or build.`,
        container
            ? `Shared service: container ${name} keeps running until cutover, is stopped gracefully (up to 75 seconds) and replaced.`
            : `Shared service: creates container ${name}.`,
        `Data: reuses volume ${settings.volumeName}${settings.codexAuthDir ? " and the Codex credential directory" : ""}, the same ports, bind address and worker identity.`,
        ...(previousImage && previousImage !== image.id
            ? ["Warning: a different Hindsight version may migrate the reused database; replacing the image does not roll the database back."]
            : []),
    ];
    if (!await ui.confirm("Apply the Hindsight CPU runtime?", plan.join("\n"))) return;
    const lease = await takeLease("apply", image.id);
    if (!lease) {
        ui.notify("Hindsight: another OMP process is changing the local runtime; nothing was applied. Try again when it finishes.", "warning");
        return;
    }
    ui.notify("Hindsight: applying the approved CPU runtime in the background.", "info");
    void runOperation(ui, lease, () => applyApproved({ settings, imageId: image.id, digests: image.digests }, lease));
}

async function applyApproved(plan: ApprovedPlan, lease: string): Promise<Outcome> {
    const { settings } = plan;
    const fail = async (stage: FailureStage, message: string, level: Outcome["level"] = "error"): Promise<Outcome> => {
        await updateState(state => state && { ...state, failure: { mode: "cpu", provider: settings.provider, stage, message, at: new Date().toISOString() } });
        return { level, message };
    };
    // Writes are atomic renames, so an unlocked read is consistent; the lease excludes competing lifecycle work.
    const current = resolveSettings().settings;
    const cached = await inspectImage(settings.image);
    const state = readState();
    const changed = state?.operation?.id !== lease ? "another process took over local management"
        : state.mode !== "cpu" ? "local management was turned Off"
        : current?.provider !== settings.provider || current.configDigest !== settings.configDigest ? "the provider configuration changed after approval"
        : cached?.id !== plan.imageId ? "the cached image changed after approval"
        : undefined;
    if (changed) return fail("validate", `Hindsight: nothing was replaced because ${changed}; review /hindsight and apply again.`, "warning");

    const name = settings.containerName;
    const existing = await inspectContainer(name);
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
    if (!await runManagedContainer(settings, plan.imageId, state!.installationId)) {
        log("docker run failed during cutover");
        if (!previous) return fail("cutover", "Hindsight: the new container could not be created; see the extension's hindsight.log");
        await docker(["rm", name]);
        const restored = (await docker(["rename", previous, name])).exitCode === 0 &&
            (!existing!.running || (await docker(["start", name])).exitCode === 0);
        return fail("cutover", restored
            ? "Hindsight: the new container could not be created; the previous container was restored."
            : `Hindsight: the new container could not be created and the previous container ${previous} could not be restored; restore it manually.`);
    }
    if (!await waitUntilReady(settings)) {
        await docker(["stop", "--time", "75", name], 90_000);
        return fail("readiness", `Hindsight: the new container ${name} did not report a healthy API and database and was stopped.` + (previous
            ? ` The previous container is preserved as ${previous}; the database may already have been migrated, so restoring it is a manual decision.`
            : ""));
    }
    await updateState(current => current && {
        ...current,
        active: { mode: "cpu", provider: settings.provider, configDigest: settings.configDigest, upstream: { reference: settings.image, digests: plan.digests }, imageId: plan.imageId, appliedAt: new Date().toISOString() },
        failure: undefined,
    });
    const ready = `Hindsight: CPU runtime ready (API :${settings.apiPort}, UI :${settings.uiPort})`;
    if (previous && (await docker(["rm", previous])).exitCode !== 0) {
        return { level: "warning", message: `${ready}; the previous container ${previous} could not be removed.` };
    }
    return { level: "info", message: ready };
}
