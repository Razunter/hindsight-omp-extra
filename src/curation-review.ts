import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DISPLAY_BYTES = 20_000;
const APPROVAL_MS = 120_000;

export async function confirmArchive(ui: ExtensionContext["ui"], review: string, signal?: AbortSignal) {
    if (Buffer.byteLength(review) > DISPLAY_BYTES) return "too_large" as const;
    const timeout = AbortSignal.timeout(APPROVAL_MS);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const renderable = review.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, character => character === "\n" ? "\n" : `\\u{${character.codePointAt(0)!.toString(16)}}`);
    try {
        // Older hosts lack these exports; only archive review should be unavailable.
        const { decodeKey } = await import("@oh-my-pi/pi-tui/driver/input/keys");
        const { wrap } = await import("@oh-my-pi/pi-tui/text/width");
        return await ui.custom<"approved" | "declined">((host, _theme, _keys, done) => {
            let page = 0;
            let width = 0;
            let height = 0;
            let lines: string[] = [];
            let lastPage = false;
            let rendered = false;
            const availableRows = () => Math.min(22, Math.floor(host.size().rows / 2)) - 3;
            return {
                render(columns) {
                    const rows = availableRows();
                    if (rows < 3 || columns < 44) {
                        rendered = false;
                        return ["Resize to review. Esc cancels."];
                    }
                    if (columns !== width || rows !== height) {
                        if (columns !== width) lines = wrap(renderable, columns);
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
                    const event = decodeKey(input, { kitty: false, backspaceIsCtrl: false });
                    const key = event?.id;
                    if (key === "escape" || key === "enter") return done("declined");
                    if (!rendered || availableRows() !== height || host.size().columns !== width) return;
                    if (lastPage && key === "a" && event.kind === "press") return done("approved");
                    if (key === "pageDown" && !lastPage) page++;
                    else if (key === "pageUp" && page > 0) page--;
                    else return;
                    rendered = false;
                    host.requestRender();
                },
            };
        }, { overlay: true, fullscreen: true, signal: deadline });
    } catch {
        return timeout.aborted ? "timeout" as const : "declined" as const;
    }
}
