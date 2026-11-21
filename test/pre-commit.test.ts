import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "../hooks/pre-commit");

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openRepo() {
    const root = mkdtempSync(join(tmpdir(), "hindsight-pre-commit-"));
    roots.push(root);
    const cwd = join(root, "repo");
    const bin = join(root, "bin");
    mkdirSync(cwd);
    mkdirSync(bin);
    const env = {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: root,
        TMPDIR: root,
        GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd, env });
        if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    const write = (path: string, content = "updated\n") => {
        const target = join(cwd, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    };
    writeFileSync(join(bin, "bun"), `#!/bin/sh
set -eu
printf '%s\\n' "$*"
if [ -f src/index.ts ]; then cat src/index.ts; fi
if [ -e scratch.ts ]; then printf 'untracked\\n'; fi
exit "$FIXTURE_CHECK_EXIT"
`, { mode: 0o700 });
    git("init", "-q", "--template=");
    write("README.md", "readme\n");
    write("docs/old.md", "old docs\n");
    write("src/index.ts", "initial\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
    return {
        cwd, git, write,
        check(exitCode = 0, extraEnv: Record<string, string> = {}) {
            const result = Bun.spawnSync(["sh", hook], {
                cwd,
                env: { ...env, FIXTURE_CHECK_EXIT: String(exitCode), ...extraEnv },
            });
            return { status: result.exitCode, output: result.stdout.toString() };
        },
    };
}

test("documentation additions, edits and removals skip checks even with unstaged code changes", () => {
    const { check, git, write } = openRepo();
    const nestedGuide = 'docs/nested/a "quoted"\nfile.md';
    for (const path of ["README.md", "CHANGELOG.md", "docs/new.md", nestedGuide]) write(path);
    git("rm", "docs/old.md");
    git("add", "--", "README.md", "CHANGELOG.md", "docs");
    write("src/index.ts", "unstaged\n");

    expect(check(17)).toEqual({ status: 0, output: "" });
});

test("mixed changes check only the staged export and propagate Bun failure", () => {
    const { check, git, write } = openRepo();
    write("README.md");
    write("src/index.ts", "staged\n");
    git("add", "README.md", "src/index.ts");
    write("src/index.ts", "unstaged\n");
    write("scratch.ts");

    expect(check(17)).toEqual({ status: 17, output: "run check\nstaged\n" });
});

test.each([
    "skills/hindsight-ingest/SKILL.md",
    "docs/data.json",
    "CHANGELOG.md/generated.ts",
    "notes\nwith a quote\".md",
])("staged %j runs checks", (path) => {
    const { check, git, write } = openRepo();
    write(path);
    git("add", "--", path);

    expect(check()).toEqual({ status: 0, output: "run check\ninitial\n" });
});

test.each([
    ["src/index.ts", "docs/moved.md", ""],
    ["docs/old.md", "new-skill.md", "initial\n"],
])("a staged rename from %s to %s runs checks", (source, destination, contents) => {
    const { check, git } = openRepo();
    git("mv", source, destination);

    expect(check()).toEqual({ status: 0, output: `run check\n${contents}` });
});

test("a symlink staged at a documentation path runs checks", () => {
    const { check, cwd, git } = openRepo();
    symlinkSync("../src/index.ts", join(cwd, "docs/link.md"));
    git("add", "docs/link.md");

    expect(check()).toEqual({ status: 0, output: "run check\ninitial\n" });
});

test("an unreadable index does not silently skip checks", () => {
    const { check, cwd, write } = openRepo();
    write("invalid-index", "not a Git index\n");

    expect(check(0, { GIT_INDEX_FILE: join(cwd, "invalid-index") }).status).not.toBe(0);
});
