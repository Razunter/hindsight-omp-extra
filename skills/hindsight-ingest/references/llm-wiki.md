# Read llm-wiki from disk

Use this branch for an llm-wiki vault or page supplied to Hindsight ingest. Read the vault directly with filesystem tools; it works with llm-wiki disabled and leaves the vault unchanged.

## Locate and enumerate

Use the supplied vault path. For “this project's wiki,” look for `.llm-wiki` in the active project; report a missing vault rather than creating one. Read its `WIKI_SCHEMA.md` and `config.json` when present to learn the actual layout. Wiki mode or vault identity describes the source, not the destination Hindsight scope.

Enumerate actual knowledge pages under `wiki/`. `meta/index.md` or `meta/registry.json` can guide traversal but are generated projections: account for pages on disk even when projections are missing or stale. A supplied page limits ingestion to that page and evidence needed to interpret it; a supplied vault covers all its knowledge pages.

## Distill knowledge, not bookkeeping

Read page frontmatter and body together. Preserve title, type, status, and relevant created/updated dates in the source context. Source pages describe what a source said; synthesis, analysis, entity, concept, and requirement pages may add durable conclusions. Capture decision rationale, actionable lessons, constraints, and unresolved tensions rather than reproducing page structure.

Treat superseded or rejected material as historical evidence, not current guidance; retain it only when its history is useful and label it accordingly. An old observation is dated evidence, not proof of today's code or configuration. Merge repeated knowledge across source and synthesis pages while keeping provenance to the contributing pages.

Exclude generated indexes, backlinks, logs, event ledgers, search/vector caches, and navigation-only content. In particular, `meta/events.jsonl` is activity history, not a collection of knowledge memories. Use `raw/sources/<id>/manifest.json` and `extracted.md`, when present, only to recover evidence or provenance needed by a page; avoid separately importing a raw packet already represented by a knowledge page.

## Resolve provenance

Resolve legacy `[[folder/page]]` links under `wiki/` with a `.md` suffix, and wiki-root links such as `/sources/<id>.md` against the vault's `wiki/`, not the filesystem root. Follow relevant evidence links within the supplied vault, and record missing links as gaps. Preserve original external source URLs when available alongside the local page path and section.

Done: every in-scope knowledge page has a coverage result; generated material and redundant raw packets are excluded; memories carry page provenance and distinguish historical claims from current guidance.
