# Configuration and local management lifecycle

[Back to the README](../README.md) · [First-run setup](setup.md)

## Network binding

Both published ports bind to `127.0.0.1` by default. Set `HINDSIGHT_BIND_ADDRESS` in the extension-root `.env`, the selected provider profile, or the launcher process environment to override both. Precedence is process environment, selected profile, base `.env`, then `127.0.0.1`.

The value must be a literal IPv4 or IPv6 address, without brackets or a port. For example, `0.0.0.0` publishes on all IPv4 interfaces; `::1` uses IPv6 loopback. Hostnames, empty values and malformed addresses fail before Docker is invoked. When using IPv6, also update OMP’s `hindsight.apiUrl` to a matching reachable URL, such as `http://[::1]:8888`.

Wider access is operator-owned: configure appropriate authentication and network controls before exposing the API or dashboard. Localhost binding does not authenticate local clients.

Changing or removing the override is a pending configuration change. Apply it from `/hindsight` to replace the container with the new bindings on the same named data volume; until then the running container keeps its old bindings.

## When changes apply

Local Hindsight management is Off by default. In Off, these files are not read for validation and Docker is not contacted. With CPU or GPU management on, changes to `.env`, the selected profile, or the saved provider selection become a pending configuration that you apply from `/hindsight` after one confirmation, in the current OMP process. File edits never restart Docker by themselves, and startup never applies them. Comments or edits that leave the effective configuration unchanged are not pending.

The container keeps running after OMP exits (`--restart unless-stopped`). Stopping OMP does not stop Hindsight. See [stopping the container](setup.md#stop-the-container).

## Shared infrastructure

The extension root `.env` supplies defaults; `providers/<selected-name>.env` overrides them. The launcher forwards every variable in the validated merged configuration to the container, regardless of prefix, including empty values and launcher settings. This exposes all credentials in those files to the container. Include only values intended for Hindsight. The host process environment is not forwarded wholesale. Optional `HINDSIGHT_BIND_ADDRESS` and the required Docker settings below use this precedence: process environment, selected profile, then base `.env`.

- HINDSIGHT_CONTAINER_NAME, HINDSIGHT_IMAGE, HINDSIGHT_VOLUME_NAME
- HINDSIGHT_WORKER_ID, HINDSIGHT_API_WORKER_MAX_SLOTS
- HINDSIGHT_API_PORT, HINDSIGHT_UI_PORT

The launcher writes container variables to a temporary environment file with permissions `0600` inside an owner-only directory. It passes the path through Docker's `--env-file`. API keys, authorization headers, and credential-bearing proxy URLs stay out of command-line arguments. Container variables do not change the Docker client's environment. The launcher removes the file after container creation succeeds or fails. Abrupt process termination can leave the owner-only temporary directory behind. Credentials remain container environment values visible to Docker administrators.

Environment values containing line breaks are rejected before Docker work, so a value cannot introduce another env-file entry.

Ports must be 1–65535 and worker slots a positive integer. Paths are relative to the extension root, independent of the project or its model selection. Logs, management state (`.local-management.json`) and temporary development state remain local.

For native settings, the selected profile overrides the base `.env`. Independent process provider/model/key overrides are not used. The combined configuration must contain a supported provider, model, schema boolean, positive concurrency and the appropriate authentication. A profile may omit settings supplied by the base.

If a profile changes the native LLM provider or explicitly changes its endpoint, it does not inherit the base model, API key, endpoint, headers or Codex auth-directory settings. Supply that target's model and authentication in its profile. Common defaults and unrelated settings remain intact. A missing target credential fails before any Docker mutation. Launcher-owned worker settings and the mounted Codex home remain authoritative.

The merged `HINDSIGHT_API_PORT` is also the container API port (default `8888` when absent). Docker maps the effective host API port to it. The container control-plane port is `HINDSIGHT_CP_PORT` (default `9999`), mapped from the effective host `HINDSIGHT_UI_PORT`. Host process port overrides change publishing, not the forwarded file values. Both host and container ports are validated. Unless explicitly configured, `HINDSIGHT_CP_DATAPLANE_API_URL` points to the container API at its configured port.

The managed container gets 1 GiB of Docker shared memory for PostgreSQL.

For native Codex mounts, the approved configuration records the canonical host directory, so retargeting a symlinked auth directory is a pending configuration change.

## Named provider configurations

Create providers/<name>.env under the extension root. Names contain letters, digits, underscores or hyphens and start with a letter or digit. Files must resolve inside providers/; escaping symlinks are rejected. Provider files, .selected-provider and credentials/ (for dedicated local authentication material) are Git-ignored. Restrict local permissions because profiles contain secrets. Do not commit them.

### Copy a complete example

The provider templates below live in [examples/](../examples/), outside the active profiles directory. Each supplies all required provider settings; none is selected or loaded automatically. The root [`.env.example`](../.env.example) contains shared Docker settings and commented native configuration examples. The [setup guide](setup.md) uses this file.

| Template | Target / protocol |
| --- | --- |
| [openai.env.example](../examples/openai.env.example) | OpenAI Chat Completions |
| [anthropic.env.example](../examples/anthropic.env.example) | Anthropic Messages |
| [deepseek.env.example](../examples/deepseek.env.example) | Official DeepSeek API with native JSON-object output |
| [openai-responses.env.example](../examples/openai-responses.env.example) | OpenAI Responses |
| [openai-codex.env.example](../examples/openai-codex.env.example) | Native Codex with dedicated file credentials |
| [opencode-zen-chat.env.example](../examples/opencode-zen-chat.env.example) | OpenCode Zen pay-as-you-go Chat Completions |
| [opencode-zen-messages.env.example](../examples/opencode-zen-messages.env.example) | OpenCode Zen pay-as-you-go Anthropic Messages |
| [opencode-zen-responses.env.example](../examples/opencode-zen-responses.env.example) | OpenCode Zen pay-as-you-go Responses |

From the extension root, copy only the intended template to a new profile name. These commands refuse to overwrite an existing profile and restrict the new file’s permissions:

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

1. Replace every `replace-with-...` model/key value in `providers/primary.env` with your intended model and independently authorized credential. These are literal placeholders, not working credentials or model recommendations. Codex instead needs an existing absolute dedicated auth-directory path and independently authorized file credentials. Follow [Native Codex authentication](#native-codex-authentication).
2. Keep the required [shared infrastructure](#shared-infrastructure) and common defaults in the root `.env`; profiles override only what differs. The complete examples also work without base LLM defaults. OpenAI, Anthropic and Responses examples use native default endpoints. For an OpenAI-compatible service, add `HINDSIGHT_API_LLM_BASE_URL=https://your-compatible-endpoint.example/v1` to the OpenAI profile and use that service's own model/key. Zen templates already set the required protocol endpoint. Use a bare model ID, without `opencode/`.
3. Keep `STRICT_SCHEMA` as `true` or `false` and `MAX_CONCURRENT` as a positive integer suited to your model/image and quota. Templates using `true` require a model/endpoint that supports strict structured output. Use `false` for JSON-object-only services. Choose a model meeting [Hindsight's output and schema requirements](https://hindsight.vectorize.io/developer/models#model-requirements), or lower its retain output budget as documented there.
4. In OMP, run `/hindsight`, choose **Provider configuration** and select `primary` (or your chosen filename without `.env`). In Off mode this only saves the name. With CPU or GPU management on, confirm the displayed plan to apply it in the current process.

Never source these files or put shell credential references in them: the launcher reads literal values. Do not copy all examples into active profiles, reuse OMP tokens, or commit populated profiles. Setup remains operator-owned; copying a template does not authorize login, inference or credential migration.

These templates use native providers openai, anthropic, deepseek, openai-responses and openai-codex. The combined base and selected profile must supply a provider, model, schema boolean and positive concurrency. Key-based providers also require their own API key. BASE_URL is optional for native defaults; Zen templates set an explicit gateway endpoint. DEFAULT_HEADERS, when present, is a JSON object with string values, for example:

```dotenv
HINDSIGHT_API_LLM_DEFAULT_HEADERS='{"User-Agent":"omp-hindsight"}'
```

Use simple literal KEY=VALUE entries, optionally quoted. There is no shell execution or interpolation: $VAR remains literal, not an environment credential reference. `OLLAMA_API_KEY` in either file is forwarded literally, but is not substituted for the required native LLM API key. Process provider/model/key overrides are not used. Credentials are never borrowed from ~/.omp/agent/.env.

Optional `HINDSIGHT_API_LLM_REASONING_EFFORT` can be a base default or selected-profile override and is forwarded to Hindsight. Omitting it from both files restores the model's native default. Adding, changing or removing it is a pending configuration change until applied from `/hindsight`. Support depends on the provider/model and installed image; see Hindsight's [reasoning configuration](https://hindsight.vectorize.io/developer/performance).

Hindsight supports [separate reflect models](https://hindsight.vectorize.io/developer/configuration); native per-operation settings in either file are forwarded too. Hindsight validates these additional settings; forwarding does not prove provider/image support. Configure each target's endpoint, model, and independently authorized credential rather than borrowing OMP credentials.

### Official DeepSeek API

The [DeepSeek template](../examples/deepseek.env.example) connects directly to DeepSeek. It uses Hindsight's native `deepseek` provider so its adapter handles DeepSeek's JSON-object response format, including calls that request strict schemas. DeepSeek documents JSON-object output rather than the strict `json_schema` response format; keep `STRICT_SCHEMA=false`.

The template uses the current [`deepseek-flash` model](https://api-docs.deepseek.com/) and an independently issued DeepSeek API key. `REASONING_EFFORT=none` disables its default thinking mode, as documented in the [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion). The launcher forwards that setting to Hindsight.

### Native Codex authentication

Use an independently authorized dedicated host directory, not a copy of OMP tokens or another runtime’s rotating credentials. Configure native file storage (cli_auth_credentials_store = "file"). Run the installed Codex CLI’s login flow with CODEX_HOME pointing to that directory. Hindsight’s current [setup documentation](https://hindsight.vectorize.io/developer/models) shows codex auth login; verify syntax for your installed CLI. The operator must log in; this extension never does.

A Codex profile uses:

```dotenv
HINDSIGHT_API_LLM_PROVIDER=openai-codex
HINDSIGHT_API_LLM_MODEL=your-entitled-codex-model
HINDSIGHT_API_LLM_STRICT_SCHEMA=true
HINDSIGHT_API_LLM_MAX_CONCURRENT=3
HINDSIGHT_OMP_CODEX_AUTH_DIR=/absolute/dedicated/hindsight-codex
```

No static LLM key is required. `HINDSIGHT_OMP_CODEX_AUTH_DIR` is forwarded as file metadata, but Hindsight uses the mounted container path, not the host path. The launcher mounts the whole directory read-write at /home/hindsight/.codex and sets HINDSIGHT_API_LLM_CODEX_HOME to that path. Do not set the native container home in the profile. The existing Docker volume syntax cannot represent directory paths containing colons, so they are rejected.

Local checks require a readable/writable/searchable directory and a regular, readable auth.json containing nonempty native tokens.access_token and tokens.refresh_token strings. The mount cannot contain OMP’s default or PI_CODING_AGENT_DIR agent storage, including symlinked storage roots. This does not prove token provenance: independently authorize it and leave Hindsight as the sole refresh owner. The extension does not refresh, copy, display or edit tokens.

Native refresh locks, sibling temporary files and atomic replacement require the whole directory, not just auth.json. Container-user permissions must allow reading and persisting credentials. Host access checks cannot prove the Docker container UID can write or that a token/model is accepted remotely. Confirm these separately against an authorized image and account. Replacement preserves the directory; changing its host path is a pending configuration change. Switching back to a key-based profile removes the Codex mount and native auth-home setting.


### OpenCode Zen protocol choices

The Zen examples use OpenCode's pay-as-you-go Console API with an independently issued key and a paid model. Free-tier chat models are restricted to the OpenCode client. Use a bare model ID, without the CLI prefix `opencode/`, and choose a model that supports structured output. See the official [model catalog](https://opencode.ai/docs/zen/) and [protocol base URLs](https://opencode.ai/v2/docs/console/harnesses#base-urls).

| Protocol | Native provider | SDK base URL |
| --- | --- | --- |
| Chat Completions | openai | https://opencode.ai/inference/openai/v1 |
| Anthropic Messages | anthropic | https://opencode.ai/inference/anthropic |
| Responses | openai-responses | https://opencode.ai/inference/openai/v1 |

The Anthropic SDK appends `/v1/messages`, so its base excludes `/v1`. OpenCode documents [Bearer authentication for Anthropic clients](https://opencode.ai/v2/docs/console/harnesses/claude-code): put the same Zen key in `HINDSIGHT_API_LLM_API_KEY` and the Messages template's `Authorization` header. Replace both literal placeholders; there is no variable interpolation. The OpenAI adapters already send the key as Bearer authentication.


## Local management lifecycle

`/hindsight` is the single menu for local Hindsight management. It needs an interactive session and works without any local setup.

- **Status** shows the requested mode, the requested provider configuration, the last approved runtime (mode, provider, image ID, upstream reference, time; for GPU the CUDA image and the upstream digest it was built from), pending configuration, the last failure with its mode and stage, a cleanup failure after the last healthy cutover, the last update check and any operation in progress, as separate lines. A requested change is never shown as the active runtime: a failed GPU request stays requested and failed while the previous runtime keeps running. In Off, status uses only stored state and says Docker was not inspected.
- **Mode** switches between **Off**, **CPU** and **GPU**. Off is the default and takes effect immediately for every OMP process of this installation without stopping the container or deleting anything. GPU is never chosen for you. Choosing CPU or GPU records the request and continues to the apply step. CPU needs no CUDA, NVIDIA driver or GPU.
- **Provider configuration** lists contained profile names, never credentials, and atomically saves just the name in `.selected-provider`. Cancellation, a disappearing profile or a failed write preserves the previous saved choice. An empty or missing profiles directory reports setup guidance instead of opening an empty dialog. With CPU or GPU management on, it continues to the apply step.
- **Apply requested configuration** validates the selected configuration (containment, native settings, Codex auth) before any Docker work, then applies it on the approved upstream image: the registry digests of the active runtime, or for a first installation the image cached under the configured reference, otherwise the target a check reported. A recorded update is not taken here, so a provider or mode change can be applied while an update is pending. When the approved image left the cache it is downloaded again by its digest (GPU: rebuilt from it). With no known target (a first installation without a cached image) it starts an update check and changes nothing; choose Apply again once the check reports the target. One confirmation then shows the provider configuration, the cached image ID, the exact `repository@digest` to download or the CUDA build (see [GPU runtime](#gpu-runtime)), the data volume, whether an existing container is replaced, and a migration warning when the Hindsight image differs from the running one. There is no separate download-only step.
- **Apply available update** offers the update the last check recorded, with the same single confirmation and background work: a download in CPU mode, a CUDA rebuild from the new base in GPU mode. Without a recorded update it changes nothing.
- **Check for updates** reads registry metadata for the configured image right away, ignoring the daily interval. It needs CPU or GPU management on and a valid configuration; see [update checks](#update-checks).

Mode, approval and runtime state are installation-wide and stored in `.local-management.json` (mode `0600`, written atomically under a short lock). Provider and credential files are never rewritten. A legacy installation without that file is treated as Off and receives one notice.

### Installing and updating a CPU runtime

After approval the handler returns and the work continues in the background; one notification says it started and one reports the outcome. A download target is pulled with `docker pull <repository>@<digest>` (up to one hour) while the current container keeps running; Docker's output is drained and never shown or logged. An image is recorded in `.local-management.json` as owned by this installation only when its image ID was not in `docker image ls --all` before the pull, so a pull that merely adds a digest to an image already cached is never claimed. A failed download leaves the container and the approved runtime unchanged and is recorded as a `prepare` failure.

The approval also binds the active runtime the plan was made against. When the lease is taken, under the state lock and before anything is downloaded or built, the extension checks that the mode is unchanged (Off chosen while the confirmation was open wins), the provider configuration is unchanged and no other process applied a runtime meanwhile. Just before the first change to the shared service (stopping, renaming or replacing the container), it checks again that it still holds the operation lease, the same conditions still hold and the prepared image still matches the approval: the cached reference still resolves to the approved image ID, or the downloaded `repository@digest` or built CUDA image is present. Because a download or build is addressed by digest, a tag or update check that moves after approval cannot change what is applied. If anything changed, nothing is replaced and the abandoned change is recorded as a failure; a downloaded or built image is kept. Once the old container is stopped the handoff is committed and finishes even if Off is chosen meanwhile, but superseded images are then kept and the outcome says so.

Cutover stops an existing container with `docker stop --time 75`, renames it to `<name>-previous-<id>`, and runs the approved image ID with the same name, data volume, Codex mount, ports, bind address, worker identity and shared memory, plus labels identifying this installation and the approved configuration. Two containers never run on the volume at once. If the new container cannot be created, the previous one is renamed back and restarted.

Success requires Hindsight’s `/health` endpoint to report `healthy` with a `connected` database within `HINDSIGHT_OMP_READINESS_TIMEOUT_SECONDS` (default 300). A wildcard bind address is probed on loopback. If the new container exits or never becomes ready, it is stopped, the previous container and both images are kept, and the failure names the preserved container. There is no automatic restore: a newer image may already have migrated the database, so going back to the old image is not a database rollback. The extension adds no backup, restore or re-embedding step.

Only after readiness (and, for GPU, a CUDA inference probe in the new container) is the runtime recorded as active, with the registry digests from the approval. The extension then removes the previous container, tags a downloaded image with the configured reference when it is a tag (a digest-pinned reference is left alone), and removes superseded images. Candidates are only the previously active image and the images `.local-management.json` records as downloaded or built by this installation; a tag prefix or Docker's list of dangling images never makes an image a candidate. Never removed: the active image, an image another live operation has claimed, any image of the active upstream release (so a CUDA derivative stays reusable after switching to CPU), an image any container, running or stopped, uses, and an image with any other tag (for a CUDA derivative, any tag besides its own `hindsight-omp-cuda:` tag). A derivative must also still carry this installation's labels and its recorded base, and a download its recorded registry digest. Each condition is checked again immediately before each `docker image rm --no-prune <image ID>`; nothing is forced or pruned, and volumes, credentials and Docker build cache are never touched. Superseded CUDA derivatives from earlier updates whose removal did not finish are removed by the next healthy cutover.

Cleanup stops when Off is chosen. A failed inspection (Docker unreachable or denied, as opposed to Docker reporting the image absent) or removal is a warning naming the image and a separate `cleanupFailure` in Status; the new runtime stays reported as ready, and the image stays recorded so the next healthy cutover tries again and clears the failure when it finishes cleanly. A failed build, validation, launch or readiness check removes no image. Removing an image frees only layers no other image or the build cache shares, so `docker system df` can still show the space allocated; reclaiming build cache (`docker builder prune`) is the operator's decision.

### GPU runtime

GPU mode runs the configured local embedding and reranker models on an NVIDIA GPU. It needs an NVIDIA driver, the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and a Docker daemon that accepts `docker run --gpus all`; the extension installs none of these. A model counts as local when its `HINDSIGHT_API_EMBEDDINGS_PROVIDER` or `HINDSIGHT_API_RERANKER_PROVIDER` is unset or `local` and its `HINDSIGHT_API_*_LOCAL_FORCE_CPU` is not true. With no local model, GPU is refused before any confirmation or Docker work. Providers, model identities, force settings, embedding dimensions and stored vectors are not changed.

The upstream image has CPU-only PyTorch, so GPU mode builds an extension-owned CUDA derivative from the approved upstream `repository@digest`, adapted from Hindsight's [official CUDA recipe](https://github.com/vectorize-io/hindsight/tree/main/docker/docker-compose/cuda). The build context is a temporary directory holding only the generated Dockerfile; no provider file, credential or agent state, and the only build argument is `BASE=<repository>@<digest>`. The build replaces the base's torch wheel with the CUDA 12.6 wheel of the same torch version, runs `uv pip check`, fails if any other installed package would change, and asserts that PyTorch has CUDA. Unlike the official recipe it also installs `gcc` and `libc6-dev` (as root, then back to the `hindsight` user): on CUDA, PyTorch JIT-compiles Triton kernels for some local models, such as ModernBERT rerankers, and without a C compiler the model fails at initialization with `Failed to find C compiler`. It is tagged `hindsight-omp-cuda:<first 12 hex of the base digest>` and labelled with this installation, `derivative=cuda` and the base, and recorded as owned in `.local-management.json`. Expect about 11 GB on disk (the CPU wheel stays in the base layers). The build runs in the background for up to two hours; its output is drained and never shown or logged, because pulling the base can echo registry errors. To see a failing build's output, rerun the Dockerfile from the official recipe by hand with the base from the confirmation.

The derivative is reused, never rebuilt, on later approvals for the same base and on ordinary restarts. A new upstream release is rebuilt only through **Apply available update**. Update checks compare the configured upstream reference's registry digests, never the local CUDA tag.

Before cutover a throwaway container of the prepared image runs the GPU inference probe: `docker run --rm --pull never --gpus all --env-file <0600 file> --entrypoint /app/api/.venv/bin/python <image ID> -c <probe>`, with the configured environment but no volume and no ports. The probe builds each local model with Hindsight's own factories (`create_embeddings_from_env`, `create_cross_encoder_from_env`), initializes it, runs one `encode` or `predict`, and reports each local backend's device; only local models are built, so no remote provider is contacted. A missing driver or toolkit, a CPU-only host, a dependency conflict, a failed build or a model that fails inference or runs off CUDA stops here: the current service keeps running, the failure is recorded, GPU stays requested, and nothing falls back to CPU. The new container gets `--gpus all`, and the GPU request is part of the configuration identity, so CPU and GPU containers never match each other at startup. Readiness additionally runs the same probe inside the running container with `docker exec` (up to five minutes) and requires `cuda` for every local backend; a device that cannot be determined counts as a failure. A model on `cpu` or a failed inference fails readiness like an unhealthy API: the new container is stopped, the previous container and both images are kept, and no image is removed. Driver visibility or an initialization log line alone never counts as GPU success.

### Startup recovery

Only a fresh interactive main OMP process acts on startup, once per process; `/new`, `/reload`, headless sessions and subagents do not. In Off, startup does nothing. With CPU or GPU requested:

- No approved runtime yet: a warning points to `/hindsight`; Docker is not contacted.
- The approved container is running: it is reported as running.
- The approved container is stopped: it is started and checked for readiness.
- The container is missing: it is recreated from the approved image ID (in GPU mode the cached CUDA derivative, with `--gpus all`) only when that image is still cached and the current configuration matches the approved one. A missing image or a pending change is reported instead; downloading or rebuilding the approved image is an explicit **Apply requested configuration**. Startup never pulls, builds or follows a moved tag.
- A container with the configured name that is not the approved runtime, including one whose GPU request differs from the approved mode, is left untouched and reported.

A pending configuration is always reported and never applied at startup.

### Update checks

An update check reads the configured `HINDSIGHT_IMAGE` reference's registry manifest with `docker buildx imagetools inspect`. It downloads no image layers, builds nothing, and never touches the container or the approved runtime. Registry authentication is whatever Docker itself is configured with; the extension passes no credentials.

The check records the index digest and the `linux/<host architecture>` manifest digest. The runtime is **current** when either digest is one of the registry digests recorded for the approved image; local tags and image IDs are never compared. Otherwise the result is **available** and names the exact target: reference, platform manifest digest and index digest. A digest-pinned reference stays on its digest: if the registry answers with a different one, the check fails instead of offering it. A **failed** check (registry or network error, unusable metadata) and an **unsupported** one (Docker Buildx is missing) are reported as such, never as current. Registry error output is not shown or logged.

With CPU or GPU management on and an approved runtime, a fresh interactive main OMP process checks in the background after startup recovery, at most once per 24 hours across all processes of the installation. The attempt time is claimed before the registry call, so failed and interrupted attempts also wait out the interval. An available update, failure or unsupported result is a nonmodal notification; a current result is quiet. Off, headless sessions, subagents and evidence or recall requests never check.

An available update is information only. It does not approve, download, build or apply anything, and the requested and active runtimes stay unchanged. To install it, choose **Apply available update** and approve the confirmation that names the recorded target; in GPU mode that rebuilds the CUDA image from the new base.

### Coordination between OMP processes

Each lifecycle operation takes an installation-wide lease. While another live process holds it, a new approval or startup recovery is refused with a message. A lease left by a process that exited authorizes nothing and is cleared by the next operation. Approvals are never stored, so an interrupted operation cannot authorize later work.

### Images

Images are downloaded or built only through an approved apply, by registry digest, and removed only as described above after a healthy cutover. Update checks read registry metadata only. Containers are created with `--pull never` from the approved image ID. Tests use an executable fake Docker and synthetic state; they do not contact a registry or build, pull or remove real images, and no test uses a GPU.

## Migration from the old root provider tuple

1. Keep shared Docker fields and intended common native defaults in .env with the same named data volume.
2. Put the intended provider/model/endpoint and authentication overrides into a named profile. Key-based targets need their own native API key; Codex needs independently authorized file credentials in a dedicated host directory. Do not carry over a borrowed Ollama key without verifying that it is the target credential.
3. Remove obsolete root provider fields if they are no longer intended defaults. Changing provider or endpoint does not inherit the old target's model or credentials; unrelated base settings are preserved. Stop relying on process provider overrides or OMP-home credential lookup.
4. Choose the profile with `/hindsight` → **Provider configuration** (or save its name manually), then apply it from the same menu with CPU or GPU management on.

Migration is operator-owned: this extension does not edit your profile/credential files or move database contents.
