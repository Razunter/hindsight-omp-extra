# hindsight-omp-extra

An [OMP](https://github.com/can1357/oh-my-pi) extension for inspecting the sources behind recalled [Hindsight](https://hindsight.vectorize.io/) knowledge and, optionally, running Hindsight in Docker.

OMP already provides Hindsight memory tools and automatic recall and retention. This extension adds `hindsight_evidence` for searching and reading supporting sources and knowledge pages, recall guidance, a skill for importing files and URLs, and opt-in local Docker management with named provider configurations.

Use it when you need to inspect what supports a recalled claim, or when you want OMP to manage a self-hosted Hindsight container. Evidence works with any Hindsight server OMP is connected to; local management is Off until you choose it.

**Status:** vibe-coded experiment. **Licence:** [MIT](LICENSE).

## Requirements and first run

- [OMP](https://github.com/can1357/oh-my-pi) with native Hindsight support.
- Git on `PATH`.
- Docker running and accessible, only if you opt in to local management.
- A Hindsight-compatible model and its own AI API credentials. Memory processing can incur model-provider charges.
- A writable installation directory for local configuration, provider selection, and logs.

Install from Git; the extension is not published on npm:

```sh
omp --version
docker version
omp install https://github.com/Razunter/hindsight-omp-extra.git
```

Follow [first-run setup](docs/setup.md) to configure the installed package, select a provider, and enable OMP’s Hindsight backend. Then start OMP in your project:

```sh
omp
```

Installation loads the extension and bundled skill automatically. Local Docker management stays Off, including for existing installations, until you choose CPU in `/hindsight`. [Checkout loading](docs/setup.md#load-persistently) remains an alternative.

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
- **Opt-in management:** `/hindsight` shows status, switches local management between Off and CPU, selects the provider configuration, checks for image updates and applies changes after one confirmation, in the current OMP process. Off never stops or changes a running container. Existing installations get a one-time notice instead of being opted in.
- **Approved runtime only:** with CPU management on, a fresh interactive main OMP process starts the last approved container or recreates it from the approved cached image. Edited `.env` or profile files are reported as pending, never applied at startup. Nothing is downloaded automatically: at most once a day, startup reads the configured image's registry metadata and notifies you when it has moved. Headless sessions and subagents never manage Docker. The container keeps running after OMP exits; [stop it explicitly](docs/setup.md#stop-the-container) when you no longer need it.
- **Advisory recall:** the retrieval footer is on; mid-run nudges are off. Neither forces a lookup, and improved task results from nudges have not been demonstrated.

## Documentation

- [Setup](docs/setup.md) covers first run, opting in to local management, upgrading, persistent loading, and stopping the container.
- [Configuration](docs/configuration.md) covers provider profiles, bind address, credentials, and the local management lifecycle.
- [Evidence access](docs/evidence.md) covers source/page actions, limits, and expandable snapshots.
- [Recall guidance](docs/recall.md) covers the footer, lesson guidance, and optional nudges.
- [Source ingestion](docs/ingestion.md) covers files, directories, URLs, and wiki content.
- [Architecture](docs/architecture.md)
- [Changelog](CHANGELOG.md)
