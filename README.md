# hindsight-omp

An [OMP](https://github.com/can1357/oh-my-pi) extension for running [Hindsight](https://hindsight.vectorize.io/) in Docker and inspecting the sources behind recalled knowledge.

OMP already provides Hindsight memory tools and automatic recall and retention. This extension adds container startup, named provider configurations, the `hindsight_evidence` tool for supporting-source and knowledge-page search/read, recall guidance, and a skill for importing knowledge from files and URLs.

Use it when you want OMP to manage a self-hosted Hindsight instance or need to inspect what supports a recalled claim. You do not need it just to connect OMP to an existing Hindsight server.

**Status:** vibe-coded experiment. **Licence:** [MIT](LICENSE).

## Requirements and first run

- [OMP](https://github.com/can1357/oh-my-pi) with native Hindsight support.
- Docker running and accessible.
- A Hindsight-compatible model and its own AI API credentials. Memory processing can incur model-provider charges.
- A writable checkout for local configuration, provider selection, and logs.

Clone or download this repository. From its root, check:

```sh
omp --version
docker version
```

Follow [first-run setup](docs/setup.md) to configure the container, select a provider, and enable OMP’s Hindsight backend. Then launch:

```sh
omp -e "$PWD"
```

Startup runs in the background; memory may be unavailable until Hindsight is ready. See [persistent loading](docs/setup.md#load-persistently) to avoid passing `-e` each time.

## Use it

Ask OMP to find the supporting material behind a remembered decision:

```text
Find our earlier decision about authentication and read the retained source.
Distinguish what the source says from later synthesis.
```

The agent can use `hindsight_evidence` to search retained sources and read them by document ID, or search and read synthesized knowledge pages. Missing support is reported as unavailable; a knowledge page is not original-source evidence.

To import knowledge from a file, directory, URL, or pasted source:

```text
/skill:hindsight-ingest docs/architecture.md
```

The skill uses a scout to distill useful knowledge and queues it through OMP’s native `retain` tool. Source files stay unchanged. A queued submission is not confirmed persistence.

[Evidence tool reference](docs/evidence.md) · [Ingestion requirements and workflow](docs/ingestion.md)

## Defaults and limits

- **Local ports:** the launcher binds the API and dashboard to `127.0.0.1`. [`HINDSIGHT_BIND_ADDRESS`](docs/configuration.md#network-binding) overrides both.
- **Interactive startup only:** the launcher reconciles Docker once per fresh interactive main OMP process. Headless sessions and subagents need an already-running server. The container keeps running after OMP exits; [stop it explicitly](docs/setup.md#stop-the-container) when you no longer need it.
- **Configuration changes wait for launch:** edits to `.env` or the selected provider profile take effect on the next fresh OMP launch. Changed managed settings cause container recreation with the same named data volume. Provider switches also require a fresh process; `/new` and `/reload` do not apply these changes.
- **Advisory recall:** the retrieval footer is on; mid-run nudges are off. Neither forces a lookup, and improved task results from nudges have not been demonstrated.

## Documentation

- [Setup](docs/setup.md) — first run, persistent loading, and stopping the container
- [Configuration](docs/configuration.md) — provider profiles, bind address, credentials, and image management
- [Evidence access](docs/evidence.md) — source/page actions, limits, and expandable snapshots
- [Recall guidance](docs/recall.md) — footer, lesson guidance, and optional nudges
- [Source ingestion](docs/ingestion.md) — importing files, directories, URLs, and wiki content
- [Architecture](docs/architecture.md)
