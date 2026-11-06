# Source ingestion

[Back to the README](../README.md) · [Skill instructions](../skills/hindsight-ingest/SKILL.md)

The package includes the user-invoked `hindsight-ingest` skill. The recommended Git plugin installation (`omp install https://github.com/Razunter/hindsight-omp-extra.git`) already loads it. [Persistent package loading](setup.md#load-persistently) also enables it persistently.

OMP discovers packaged skills when the package directory is loaded through `-e`, configured `extensions`, or plugin installation. A native extension-directory symlink alone loads only the launcher.

For a one-session launch without changing settings, run `omp -e /absolute/path/to/hindsight-omp-extra`, then:

```text
/skill:hindsight-ingest <file, directory, URL, or pasted source>
/skill:hindsight-ingest .llm-wiki
```

It uses the configured fast `scout` to select and distill knowledge, then submits directly through the active session’s Hindsight `retain` tool. Hindsight must be enabled with `per-project` or `per-project-tagged` scoping. The launcher alone does not configure OMP’s memory backend. Scout is read-only, so the parent forwards its memory items without a manual approval queue.

The optional [llm-wiki reference](../skills/hindsight-ingest/references/llm-wiki.md) covers reading the vault from disk with llm-wiki disabled. Source files remain unchanged. Unsupported portions are reported, and queued submissions are distinguished from verified server persistence.

For large collections, the skill uses bounded scout waves and records source versions, coverage, distilled items, and submission outcomes under the project’s `.scratch/hindsight-ingest/`. It submits completed batches incrementally rather than keeping the whole wiki in the parent context. Queued or uncertain writes require persistence evidence before replay.
