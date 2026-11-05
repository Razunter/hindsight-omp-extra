# Configuration and container lifecycle

[Back to the README](../README.md) · [First-run setup](setup.md)

## Network binding

Both published ports bind to `127.0.0.1` by default. Set `HINDSIGHT_BIND_ADDRESS` in the extension-root `.env`, the selected provider profile, or the launcher process environment to override both. Precedence is process environment, selected profile, base `.env`, then `127.0.0.1`.

The value must be a literal IPv4 or IPv6 address, without brackets or a port. For example, `0.0.0.0` publishes on all IPv4 interfaces; `::1` uses IPv6 loopback. Hostnames, empty values and malformed addresses fail before Docker is invoked. When using IPv6, also update OMP’s `hindsight.apiUrl` to a matching reachable URL, such as `http://[::1]:8888`.

Wider access is operator-owned: configure appropriate authentication and network controls before exposing the API or dashboard. Localhost binding does not authenticate local clients.

The launcher inspects actual API/dashboard port bindings as well as its managed configuration. Older all-interface bindings are replaced on the next fresh interactive main OMP launch. Changing or removing the override also reconciles both ports, retaining the named data volume.

## When changes apply

Changes to `.env`, the selected profile, or the saved provider selection take effect at the next fresh interactive main OMP process. If managed settings differ, the launcher stops/removes the old container and creates its replacement with the same named data volume. Editing a file does not immediately restart Docker; `/new` and `/reload` do not apply it. Comments or edits that leave the effective configuration unchanged do not require replacement.

The container keeps running after OMP exits (`--restart unless-stopped`). Stopping OMP does not stop Hindsight. See [stopping the container](setup.md#stop-the-container).

## Shared infrastructure

The extension root `.env` supplies defaults; `providers/<selected-name>.env` overrides them. Every variable in the validated merged configuration is forwarded to the container, regardless of prefix, including empty values and launcher settings. This exposes all credentials in those files to the container; include only values intended for Hindsight. The host process environment is not forwarded wholesale. `HINDSIGHT_BIND_ADDRESS` uses the same infrastructure precedence but is optional. These required Docker settings retain process-environment precedence: process environment, selected profile, then base `.env`.

- HINDSIGHT_CONTAINER_NAME, HINDSIGHT_IMAGE, HINDSIGHT_VOLUME_NAME
- HINDSIGHT_WORKER_ID, HINDSIGHT_API_WORKER_MAX_SLOTS
- HINDSIGHT_API_PORT, HINDSIGHT_UI_PORT

Ports must be 1–65535 and worker slots a positive integer. Paths are relative to the extension root, independent of the project or its model selection. Logs, image-check timestamps and temporary development state remain local.

For native settings, precedence is selected profile over base `.env`; independent process provider/model/key overrides are not used. The combined configuration must contain a supported provider, model, schema boolean, positive concurrency and the appropriate authentication. A profile may omit settings supplied by the base.

If a profile changes the native LLM provider or explicitly changes its endpoint, the base model, API key, endpoint, headers and Codex auth-directory settings are not inherited. Supply that target's model and authentication in its profile. Common defaults and unrelated settings remain intact; a missing target credential fails before any Docker mutation. Launcher-owned worker settings, reconciliation metadata and the mounted Codex home remain authoritative.

The merged `HINDSIGHT_API_PORT` is also the container API port (default `8888` when absent); Docker maps the effective host API port to it. The container control-plane port is `HINDSIGHT_CP_PORT` (default `9999`), mapped from the effective host `HINDSIGHT_UI_PORT`. Host process port overrides change publishing, not the forwarded file values. Both host and container ports are validated. Unless explicitly configured, `HINDSIGHT_CP_DATAPLANE_API_URL` points to the container API at its configured port.

The launcher allocates 1 GiB of Docker shared memory for PostgreSQL. Docker’s 64 MiB default caused real project-bank creation to fail with a roughly 509 MiB shared-memory allocation. Startup reconciles this limit along with environment and mounts, recreating stale containers while retaining the named database volume.

For native Codex mounts, reconciliation uses the canonical host-directory identity in the managed environment plus the writable bind mount at the container destination. Docker Desktop translates inspected mount source paths into daemon-side paths, so comparing them directly with the host path would recreate an unchanged container on every launch.

## Named provider configurations

Create providers/<name>.env under the extension root. Names contain letters, digits, underscores or hyphens and start with a letter or digit. Files must resolve inside providers/; escaping symlinks are rejected. Provider files and .selected-provider are Git-ignored, as is credentials/ for dedicated local authentication material. Restrict local permissions: profiles contain secrets. Do not commit them.

### Copy a complete example

The provider templates below live in [examples/](../examples/), outside the active profiles directory. Each supplies all required provider settings; none is selected or loaded automatically. Shared Docker settings and commented native configuration examples live in the root [`.env.example`](../.env.example), used by the [setup guide](setup.md).

| Template | Target / protocol |
| --- | --- |
| [openai.env.example](../examples/openai.env.example) | OpenAI Chat Completions |
| [anthropic.env.example](../examples/anthropic.env.example) | Anthropic Messages |
| [openai-responses.env.example](../examples/openai-responses.env.example) | OpenAI Responses |
| [openai-codex.env.example](../examples/openai-codex.env.example) | Native Codex with dedicated file credentials |
| [opencode-go-chat.env.example](../examples/opencode-go-chat.env.example) | OpenCode Go Chat Completions |
| [opencode-go-messages.env.example](../examples/opencode-go-messages.env.example) | OpenCode Go Anthropic Messages |
| [opencode-go-responses.env.example](../examples/opencode-go-responses.env.example) | OpenCode Go Responses |

From the extension root, copy just the intended template to a new profile name. The following refuses to overwrite an existing profile and restricts the new file’s permissions:

```sh
(
    set -eu
    umask 077
    mkdir -p providers
    set -C
    cat examples/openai.env.example > providers/primary.env
    chmod 600 providers/primary.env
)
```

1. Replace every `replace-with-...` model/key value in `providers/primary.env` with your intended model and independently authorized credential. These are literal placeholders, not working credentials or model recommendations. Codex instead needs an existing absolute dedicated auth-directory path and independently authorized file credentials; follow [Native Codex authentication](#native-codex-authentication).
2. Keep the required [shared infrastructure](#shared-infrastructure) and common defaults in the root `.env`; profiles override only what differs. The complete examples can still be used without base LLM defaults. OpenAI, Anthropic and Responses examples use native default endpoints. For an OpenAI-compatible service, add `HINDSIGHT_API_LLM_BASE_URL=https://your-compatible-endpoint.example/v1` to the OpenAI profile and use that service's own model/key. Go templates already bind the required protocol endpoint; use a bare model ID, without `opencode-go/`.
3. Keep `STRICT_SCHEMA` as `true` or `false` and `MAX_CONCURRENT` as a positive integer suited to your model/image and quota; the example values are not remote-compatibility guarantees.
4. In OMP, run `/hindsight-provider` and select `primary` (or your chosen filename without `.env`). This only saves the name. Exit and launch a fresh OMP process to apply it when container reconciliation is authorized; `/new` and `/reload` do not apply or retry it.

Never source these files or put shell credential references in them: the launcher reads literal values. Do not copy all examples into active profiles, reuse OMP tokens, or commit populated profiles. Setup remains operator-owned; copying a template does not authorize login, inference or credential migration.

Supported native providers: openai, anthropic, opencode-go, openai-responses and openai-codex. Provider, model, schema boolean and positive concurrency are required after combining the base and selected profile; key-based providers additionally require their own API key. BASE_URL is optional for native defaults, except Go configurations bind an explicit protocol endpoint. DEFAULT_HEADERS, when present, is a JSON object with string values, for example:

```dotenv
HINDSIGHT_API_LLM_DEFAULT_HEADERS='{"User-Agent":"omp-hindsight"}'
```

Use simple literal KEY=VALUE entries, optionally quoted. There is no shell execution or interpolation: $VAR remains literal, not an environment credential reference. `OLLAMA_API_KEY` in either file is forwarded literally, but is not substituted for the required native LLM API key. Process provider/model/key overrides are not used. Credentials are never borrowed from ~/.omp/agent/.env.

Optional `HINDSIGHT_API_LLM_REASONING_EFFORT` can be a base default or selected-profile override and is forwarded to Hindsight. The original development configuration used `low` for a Luna 6 Codex candidate; this is not a model recommendation. Omitting it from both files restores the model's native default. Adding, changing or removing it reconciles the container only in the next fresh OMP process. Support depends on the provider/model and installed image; see Hindsight's [reasoning configuration](https://hindsight.vectorize.io/developer/performance).

Hindsight supports [separate reflect models](https://hindsight.vectorize.io/developer/configuration); native per-operation settings in either file are forwarded too. Hindsight validates these additional settings; forwarding does not prove provider/image support. `openai/gpt-oss-120b` requires a separately configured compatible service and its own credential (or a self-hosted endpoint); it is not listed under the installed OMP catalog's Codex provider. The original development Codex candidate had no reflect override, so reflect used its default model. Do not add an unauthenticated override or borrow OMP credentials.

### Native Codex authentication

Use an independently authorized dedicated host directory, not a copy of OMP tokens or another runtime’s rotating credentials. Configure native file storage (cli_auth_credentials_store = "file") and perform the installed Codex CLI’s login flow with CODEX_HOME pointing to that dedicated directory. Hindsight’s current [setup documentation](https://hindsight.vectorize.io/developer/models) shows codex auth login; verify syntax for your installed CLI. Login is an operator step, never performed by this extension.

A Codex profile uses:

```dotenv
HINDSIGHT_API_LLM_PROVIDER=openai-codex
HINDSIGHT_API_LLM_MODEL=your-entitled-codex-model
HINDSIGHT_API_LLM_STRICT_SCHEMA=true
HINDSIGHT_API_LLM_MAX_CONCURRENT=3
HINDSIGHT_OMP_CODEX_AUTH_DIR=/absolute/dedicated/hindsight-codex
```

No static LLM key is required. `HINDSIGHT_OMP_CODEX_AUTH_DIR` is forwarded as file metadata, but Hindsight uses the mounted container path, not that host path. The launcher mounts the whole directory read-write at /home/hindsight/.codex and sets HINDSIGHT_API_LLM_CODEX_HOME to that container path; do not set the native container home in the profile. Directory paths containing colons cannot be represented by the existing Docker volume syntax and are rejected.

Local checks require a readable/writable/searchable directory and a regular, readable auth.json containing nonempty native tokens.access_token and tokens.refresh_token strings. The mount cannot contain OMP’s default or PI_CODING_AGENT_DIR agent storage, including symlinked storage roots. This does not prove token provenance: independently authorize it and leave Hindsight as the sole refresh owner. The extension does not refresh, copy, display or edit tokens.

The whole directory—not just auth.json—is necessary for native refresh locks, sibling temporary files and atomic replacement. Container-user permissions must allow reading and persisting credentials; host access checks cannot prove the Docker container UID can write or that a token/model is accepted remotely. Confirm these separately against an authorized image and account. The directory is preserved on recreation, and changing its host path forces reconciliation. Switching back to a key-based profile removes the Codex mount and native auth-home setting.


### OpenCode Go protocol choices

Each operator-authored Go profile must pair its bare model identifier with the documented native protocol. Do not include the CLI prefix opencode-go/ or infer the protocol from a commercial label. No model discovery/catalog is provided.

| Protocol | Native provider | SDK base URL | Additional native headers |
| --- | --- | --- | --- |
| Chat Completions | opencode-go or openai | https://opencode.ai/zen/go/v1 | Native Hindsight client/session identity depends on image support |
| Anthropic Messages | anthropic | https://opencode.ai/zen/go | Application-specific User-Agent in DEFAULT_HEADERS |
| Responses | openai-responses | https://opencode.ai/zen/go/v1 | Native Hindsight client/session identity depends on image support |

The Anthropic SDK appends /v1/messages, so its base excludes /v1. Go's protocol/model catalog and policies can change; consult the actual model documentation. Adapter support alone does not establish Go's acceptance of memory-service workloads or uniform privacy/retention guarantees. The chosen image must support native headers/session identity.

## Selection and startup timing

Run /hindsight-provider to choose a complete named configuration using the stock OMP selection dialog. Only contained names are listed, never credentials. The command atomically saves just the name in .selected-provider; it does not pull, stop or recreate Docker, edit profiles or validate remote authentication. Cancellation, a disappearing profile or a failed write preserves the previous saved choice. The confirmation states that application waits for the next fresh OMP process.

The saved record is shared across projects, independent of their model and Hindsight connection settings. You can also write just the chosen name manually (for example primary for providers/primary.env). Missing selection, invalid native settings or missing local auth reports an actionable error before Docker work, with no fallback. An empty/missing profiles directory reports setup guidance instead of opening an empty dialog.

The process makes its decision once, before asynchronous startup, even when validation or Docker fails. New sessions, /new and /reload do not apply a changed selection or retry startup. Exit OMP and launch a fresh process to apply it. Subagents and noninteractive sessions do not read configuration or reconcile the shared container.

Docker reconciliation runs in the background, so a slow image pull does not block OMP or exceed its 30-second extension-handler deadline. A final notification reports readiness or failure after reconciliation and owned-image cleanup finish. Hindsight memory may be unavailable until the container is ready. Docker command timeouts remain bounded; exiting OMP before completion can interrupt reconciliation.

Reconciliation compares presence and value of managed fields: removing an explicit native setting forces replacement, while unrelated image environment values are ignored. A launcher-owned list of configured keys tracks removals across fresh processes. Replacement reuses HINDSIGHT_VOLUME_NAME. The existing image-check interval and pull-failure policy are retained. Concurrent fresh-process startups can race over the shared container; cross-process locking is outside scope.

### Docker image hygiene

The launcher never builds images or globally prunes Docker. Before its explicit pull it records existing image IDs; afterwards it targets only the superseded image if now untagged, plus any image that this pull newly downloaded. Cleanup runs after reconciliation, including failed startup. It removes a candidate only when no running or stopped container uses it and no unrelated tag owns it, using image rm --no-prune without force. A newly downloaded image still used by the managed container stays installed. Preexisting cached images and unrelated legacy artifacts are preserved. Container creation uses --pull never so no implicit download bypasses this ownership check.

If Docker refuses inspection/removal, reconciliation reports an error and logs the cleanup failure rather than claiming success; operator intervention may be needed. Automatic pulls retain the daily interval, but a missing target image is fetched even within that interval. Tests and TUI verification stage an executable fake Docker and synthetic state; they do not build, pull or remove real images.

## Migration from the old root provider tuple

1. Keep shared Docker fields and intended common native defaults in .env with the same named data volume.
2. Put the intended provider/model/endpoint and authentication overrides into a named profile. Key-based targets need their own native API key; Codex needs independently authorized file credentials in a dedicated host directory. Do not carry over a borrowed Ollama key without verifying that it is the target credential.
3. Remove obsolete root provider fields if they are no longer intended defaults. Changing provider or endpoint does not inherit the old target's model or credentials; unrelated base settings are preserved. Stop relying on process provider overrides or OMP-home credential lookup.
4. Choose the profile with /hindsight-provider (or save its name manually) and restart OMP in a fresh process when container replacement is authorized.

Migration is operator-owned: this extension does not edit your profile/credential files or move database contents.
