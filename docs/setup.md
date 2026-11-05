# Setup

[Back to the README](../README.md) · [Full configuration reference](configuration.md)

This guide assumes a writable standalone checkout, an installed [OMP](https://github.com/can1357/oh-my-pi) with native Hindsight support, Docker, and a Hindsight-compatible AI provider credential and model. The commands below use a POSIX shell. Run them from the extension root unless a step says otherwise.

No `npm install` is needed to load the extension: OMP supplies its runtime imports. The package is currently marked `private`; these instructions use a local checkout, not an npm release.

## 1. Check the prerequisites

```sh
omp --version
docker version
```

Docker must report an accessible server, not just a client version. The latest recorded native verification used OMP 18.16.0; no minimum-version or cross-platform compatibility matrix has been established.

The launcher manages one shared container across projects. If you already run Hindsight, inspect your container and volume names before proceeding: pointing the launcher at an existing container authorizes reconciliation, including replacement when settings differ. Keep its volume name if you intend to preserve that database. If you only need OMP to connect to an existing server, use OMP’s native Hindsight configuration; this launcher is not required.

## 2. Create local configuration

For a new installation, copy the root [`.env.example`](../.env.example) and one provider template. This block refuses to overwrite existing files and restricts permissions:

```sh
(
    set -eu
    umask 077
    mkdir -p providers
    set -C
    cat .env.example > .env
    cat examples/openai.env.example > providers/primary.env
    chmod 600 .env providers/primary.env
)
```

If a destination already exists, keep it and edit the existing configuration rather than rerunning the copy block. The block is not transactional: if its second copy fails, the first file can already have been created.

Edit these files before launching:

- **`.env`:** choose the Docker container, named volume, image, worker settings, and API/dashboard ports. The example uses `hindsight-omp`, `hindsight-omp-data`, and ports `8888`/`9999`; change them if occupied. Both published ports bind to `127.0.0.1` by default. [Changing the bind address](configuration.md#network-binding) is explicit.
- **`providers/primary.env`:** replace the model and API-key placeholders with values authorized for Hindsight. Never copy OMP tokens or put shell variable references in this file: values are literal, not interpolated. For another provider, use the appropriate [provider template](configuration.md#copy-a-complete-example) instead.

The image example follows Hindsight’s [official Docker installation](https://hindsight.vectorize.io/developer/installation) and uses the rolling `latest` tag. For reproducible deployments, choose an image tag or digest you have verified with your provider. The launcher checks for updates at most daily on fresh startup; a newly pulled image can cause container replacement. Back up the database before upgrading. A named volume is not a backup.

Only put values intended for Hindsight in these files: the validated merged file configuration is forwarded to the container, including credentials and variables without a `HINDSIGHT_` prefix. Your selected AI provider may receive content for memory processing. Self-hosting the database does not make remote inference offline.

For a fresh setup, save the profile name without launching OMP first:

```sh
(
    set -eu
    umask 077
    set -C
    printf 'primary\n' > .selected-provider
)
```

This refuses to overwrite an existing selection. For later switches, use `/hindsight-provider` in interactive OMP; it lists names rather than credentials and saves the selected name for the next fresh process.

## 3. Enable OMP’s native Hindsight backend

### Using OMP’s settings UI

1. Start interactive OMP with `omp`, then run `/settings`.
2. Open the **Memory** tab and set **Memory Backend** to **Hindsight**. This reveals the Hindsight settings.
3. Set **Hindsight API URL** to `http://127.0.0.1:8888`, or the host address and API port you configured.
4. Set **Hindsight Scoping** to **Per project**.
5. If your server requires a bearer token, enter it in **Hindsight API Token**. This is not your AI provider’s API key.
6. Close settings and exit OMP, then continue with step 4 below to launch a fresh process with the extension.

### Alternatively: edit the configuration file

Merge the following into your active OMP configuration. For the default profile, that is `~/.omp/agent/config.yml`. Preserve unrelated settings. Named profiles and agent-directory overrides use their own configuration locations.

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://127.0.0.1:8888
  scoping: per-project
```

Match `apiUrl` to the host API address and port you configured. OMP’s `HINDSIGHT_API_URL` environment variable can override that setting. If the server requires a bearer token, configure OMP’s native `hindsight.apiToken` too; provider inference credentials and the OMP-to-Hindsight token are different credentials.

The extension does not enable this backend or edit OMP settings. Native OMP owns recall, retention, project scoping, and Auto-Learn. The `per-project` example separates banks by project identity; it is not a server authorization boundary, and projects with the same normalized basename can share a bank.

## 4. Launch and verify

From the extension root, start a fresh interactive OMP process:

```sh
omp -e "$PWD"
```

The extension downloads the configured Hindsight Docker image if it is not already cached, then creates and starts the container. **The first launch can be slow** while the image downloads and Hindsight initializes. Docker setup runs in the background, so OMP stays usable while you wait.

With the example ports, successful container reconciliation reports:

```text
Hindsight: container ready (API :8888, UI :9999)
```

That notification establishes container startup, not API readiness or provider authentication. In another terminal, check the API once it has initialized (requires `curl`):

```sh
curl --fail http://127.0.0.1:8888/health
```

The [Hindsight dashboard](http://127.0.0.1:9999) uses the example UI port. For errors, inspect `hindsight.log` in the extension root and the managed container’s Docker logs. Provider rejection, model incompatibility, or incomplete initialization can occur after the launcher reports container readiness.

The launcher starts only from an interactive main session. Headless OMP processes and subagents can use the evidence tool but do not start or reconcile Docker. Keep the server running before using those modes.

For a first ingestion trial from this checkout, follow [source ingestion](ingestion.md) and run:

```text
/skill:hindsight-ingest docs/architecture.md
```

A configured scout and active native `retain` tool are required. The skill reports what it queued or skipped; a queue acknowledgement is not confirmed server persistence. Evidence searches need retained material to find; an empty bank can legitimately return no results.

## Load persistently

To load the package without `-e`, add its absolute directory to the active OMP configuration’s `extensions` list. Replace the example path with the checkout’s actual path and preserve existing entries:

```yaml
extensions:
  - /absolute/path/to/hindsight-omp
```

Configure the package directory, not just `src/hindsight-omp.ts`, so OMP discovers the bundled `hindsight-ingest` skill as well. A symlink in OMP’s native extensions directory alone exposes the launcher but not the packaged skill. No symlink is needed when the package directory is configured explicitly.

Restart OMP after deployment. Extension package settings arrays replace rather than append across configuration layers, so check the effective list if a project or overlay also supplies `extensions`.

## Apply configuration changes

Editing `.env`, a provider profile, or `.selected-provider` does not immediately restart the container. The next fresh interactive main OMP launch reads the files and recreates the container if managed settings changed. The named data volume is reused. `/new` and `/reload` neither apply a changed selection nor retry failed startup.

The same fresh-process rule applies to `HINDSIGHT_BIND_ADDRESS`: older all-interface bindings are corrected on the next launch. Until that reconciliation has run, an already-running container retains its old bindings.

Recall-footer and nudge settings are different: they are ordinary live OMP settings, documented in [recall guidance](recall.md).

## Stop the container

The container does not stop itself when OMP exits. With the example container name, stop it explicitly:

```sh
docker stop hindsight-omp
```

Use your configured `HINDSIGHT_CONTAINER_NAME` if different. This stops the container without deleting its named data volume. The next eligible fresh OMP launch can start it again. The container uses Docker’s `unless-stopped` restart policy; closing OMP is not an instruction to stop Docker.
