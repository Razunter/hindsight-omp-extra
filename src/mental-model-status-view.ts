import type { MentalModelSnapshot } from "./mental-model-status";

export function formatMentalModelStatus(snapshot: MentalModelSnapshot | undefined, view: "summary" | "details") {
    if (!snapshot) return;
    const title = "Hindsight mental models";
    if (snapshot.state === "unchecked") return { message: `${title}: Not checked yet`, warning: false };
    if (snapshot.state === "unavailable") return { message: `${title}: Check unavailable`, warning: true };

    const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    const { models, counts, unchecked, latestCheck, oldestRefresh, unavailable } = snapshot;
    const summary = [`${models.length} ${models.length === 1 ? "model" : "models"}`];
    for (const [status, count] of Object.entries(counts)) {
        if (count && status !== "Current") summary.push(`${count} ${status.toLowerCase()}`);
    }
    if (unchecked) summary.push(`${unchecked} unchecked`);
    if (oldestRefresh !== undefined) summary.push(`oldest refresh ${date.format(oldestRefresh)}`);
    else if (models.length) summary.push("no known refresh time");
    summary.push(`checked ${date.format(latestCheck)}`);
    const label = unavailable ? "Check unavailable · last known: " : "";
    const lines = [`${title}: ${label}${summary.join(" · ")}`];
    if (view === "details") for (const { model, checkedAt } of models) {
        const refresh = model.refreshedAt === null ? "never refreshed"
            : model.refreshedAt === undefined ? "refresh time unknown" : `refreshed ${date.format(model.refreshedAt)}`;
        lines.push(`${plainStatusLabel(model.name)}: ${model.status} · ${refresh} · checked ${date.format(checkedAt)}`);
    }
    return { message: lines.join("\n"), warning: unavailable || counts.Paused > 0 || counts.Stale > 0 };
}

export function plainStatusLabel(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}
