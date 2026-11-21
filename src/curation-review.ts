import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DISPLAY_BYTES = 20_000;
const APPROVAL_MS = 120_000;

export async function confirmArchive(ui: ExtensionContext["ui"], review: string, signal?: AbortSignal) {
    if (Buffer.byteLength(review) > DISPLAY_BYTES) return "too_large" as const;
    const timeout = AbortSignal.timeout(APPROVAL_MS);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const renderable = review.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, character => character === "\n" ? "\n" : `\\u{${character.codePointAt(0)!.toString(16)}}`);
    try {
        const { matchesKey, wrapTextWithAnsi } = await import("@oh-my-pi/pi-tui");
        return await ui.custom<"approved" | "declined">((tui, _theme, _keys, done) => {
            let page = 0;
            let width = 0;
            let height = 0;
            let lines: string[] = [];
            let lastPage = false;
            let rendered = false;
            const availableRows = () => Math.min(22, Math.floor(tui.terminal.rows / 2)) - 3;
            return {
                invalidate() { rendered = false; },
                render(columns) {
                    const rows = availableRows();
                    if (rows < 3 || columns < 44) {
                        rendered = false;
                        return ["Resize to review. Esc cancels."];
                    }
                    if (columns !== width || rows !== height) {
                        if (columns !== width) lines = wrapTextWithAnsi(renderable, columns);
                        width = columns;
                        height = rows;
                        page = 0;
                    }
                    const pages = Math.max(1, Math.ceil(lines.length / rows));
                    lastPage = page + 1 === pages;
                    rendered = true;
                    return [`Hindsight archive review ${page + 1}/${pages}`, "", ...lines.slice(page * rows, (page + 1) * rows),
                        lastPage ? "a Archive · Enter/Esc Keep active" : "PgDn Next · PgUp Back · Esc Keep active"];
                },
                handleInput(input) {
                    if (matchesKey(input, "escape") || matchesKey(input, "enter")) return done("declined");
                    if (!rendered || availableRows() !== height || tui.terminal.columns !== width) return;
                    if (lastPage && input === "a") return done("approved");
                    if (matchesKey(input, "pageDown") && !lastPage) page++;
                    else if (matchesKey(input, "pageUp") && page > 0) page--;
                    else return;
                    rendered = false;
                    tui.requestRender();
                },
            };
        }, { signal: deadline });
    } catch {
        return timeout.aborted ? "timeout" as const : "declined" as const;
    }
}
