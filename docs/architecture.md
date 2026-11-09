# Architecture

[Back to the README](../README.md)

hindsight-omp-extra adds evidence access and optional local deployment to OMP's native Hindsight integration. It is an extension, not a replacement memory engine or a separate OMP build.

## Ownership

| Component | Responsibility |
| --- | --- |
| OMP | Native `retain`, `recall`, `reflect`, and `learn` tools; memory backend selection; transcript capture; project scoping; shared Auto-Learn; session artifact storage |
| Hindsight | Retained documents, extracted facts, observations, synthesized knowledge pages, and memory processing with its configured AI provider |
| This extension | Source/page evidence search and read, recall/lesson guidance, the user-invoked ingestion skill, and opt-in local Hindsight management with named provider selection |

A **supporting source** is retained material or underlying facts supporting a recalled claim. It can be unavailable even when the claim remains recallable. A **knowledge page** is synthesized knowledge, not original-source evidence.

**Transcript capture** preserves conversation content. A **curated lesson** is a selected durable fact, convention, preference, or procedure useful beyond that conversation.

## Provider configuration stays local to the extension

A named Hindsight provider configuration binds the inference provider, model, endpoint, credentials, and structured-output requirements. It is distinct from OMP’s chat-model choice and from the connection OMP uses to reach Hindsight.

The extension uses OMP's command registration and selection UI without changing OMP core. One saved selection is shared across projects because one shared container is managed. With CPU or GPU management on, a new selection is applied in the current process after one confirmation; it is never applied implicitly at startup.

Authentication belongs to Hindsight’s native adapters. There is no OMP credential gateway or inference proxy. Copying OMP’s rotating credentials would create competing refresh owners and is not supported.

Native file-based Codex authentication, where used, has its own independently authorized persistent writable directory. Hindsight owns refresh. See [provider configuration](configuration.md).

## Local Hindsight management is opt-in

Local Hindsight management is the extension's optional ownership of a local Hindsight container's lifecycle. Evidence, recall guidance and ingestion register independently of it and work against whatever server OMP's native connection points to. Management is Off by default, including for installations that predate it; Off does no Docker or provider-file work.

One installation-wide state file holds the requested mode, the last approved runtime, the last update check and the images this installation downloaded or built, separate from provider and credential files. Approval binds a concrete cached image ID or registry `repository@digest` download and the configuration identity. Downloads and cutover run in the background under an installation-wide lease while the current service keeps running, and are revalidated before cutover, so another process, Off, a provider edit or a moved tag cannot widen an approval. A runtime becomes active only after API and database readiness; only then are superseded images removed: the previous image and recorded owned images outside the active release, each revalidated just before deletion and kept while anything else tags or uses it. Update checks compare registry manifest digests of the configured upstream reference with those of the approved image, record the exact available target and authorize nothing. See the [lifecycle reference](configuration.md#local-management-lifecycle).

GPU mode is an explicit choice, never a default or a fallback target. It reuses the same approval, lease, revalidation, cutover and readiness path as CPU; only preparation differs. The extension builds an owned CUDA derivative from the approved upstream digest with a context that holds only a generated Dockerfile, records its ownership and base, and reuses it until an approved update names a new base. Update checks keep comparing the configured upstream reference. A GPU runtime counts as active only when, besides API and database readiness, each configured local model logs that it initialized on CUDA; a failed GPU request leaves the previous runtime running and stays visible as requested and failed.

## Evidence access is on demand

The `hindsight_evidence` tool adds supporting-source and knowledge-page search/read without replacing native memory tools, transcript retention, or Auto-Learn. It does not add a durable outbox, replay machinery, or stronger delivery guarantees for native writes.

Routine previews are bounded. When local presentation limits omit permitted content, the extension stores the complete validated, allowlisted result in an OMP session artifact. The agent can read that same snapshot locally without another Hindsight request. This uses native artifact storage rather than an extension-owned cache or cursor protocol.

Scope checks happen before artifact creation. Excluded evidence and unverified knowledge pages never enter the snapshot. Backend omissions remain omissions.

An artifact records fetch-time scope and content. Later retagging or deletion does not revoke it. A fresh evidence read rechecks current scope. Tags are retrieval filters, not server authorization.

## Guidance does not own retrieval or capture

The retrieval footer and optional recall nudges advise the main agent to consider relevant history. The agent chooses whether to retrieve and which enabled route to use. Delivery does not itself issue searches, run another capture agent, or take ownership of transcript retention.

The retrieval footer is enabled by default. Dynamic nudges are independently disabled by default. A positive completed-work interval enables them.

Counting successful leaf-tool results avoids a catalog-specific work-tool list, with explicit exclusions for known control, memory, and wrapper operations. It is a coarse cadence heuristic, not semantic progress analysis.

Curated lesson guidance asks for evidence-backed corrections, attribution, scope, and observed procedure outcomes. It adds no writer or persistence guarantee. Useful-retrieval and task-correctness benefits from dynamic nudges remain unestablished.
