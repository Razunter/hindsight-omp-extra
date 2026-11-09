# Setup

[Back to the README](../README.md) · [Full configuration reference](configuration.md)

Requires a writable installation directory, [OMP](https://github.com/can1357/oh-my-pi) with native Hindsight support, [Bun](https://bun.sh/), Git on `PATH`, and a Hindsight-compatible AI credential and model. Local Docker management additionally needs Docker. Commands use a POSIX shell and run from the extension root unless stated otherwise.

Evidence access and recall guidance work with any Hindsight server OMP is connected to. To use an existing server without local management, install the extension, skip steps 2 and 4, and configure OMP's native Hindsight connection in step 3. Local management stays Off until you choose CPU in `/hindsight`.

OMP supplies the extension's runtime imports; no separate dependency installation or build is needed to load its source.

## 1. Check the prerequisites

```sh
bun --version
omp --version
docker version
```

Docker must report an accessible server, not just a client version. OMP 18.16.0 and Bun 1.4.4 have been exercised; no minimum-version or cross-platform compatibility matrix has been established.

Local management controls one shared container across projects. If you already run Hindsight, inspect its container and volume names first. Applying CPU management to an existing container with the configured name replaces it after your confirmation. Keep its volume name to preserve the database.

## Install from Git

```sh
omp install https://github.com/Razunter/hindsight-omp-extra.git
cd "$HOME/.omp/plugins/node_modules/hindsight-omp-extra"
```

The `cd` path is the default-profile installation location. If you use another profile or configuration root, find the package's `path` with `omp plugin list --json` and use that directory.

OMP installs and enables the package for your user, including the launcher and bundled `hindsight-ingest` skill. No manual clone or `extensions` entry is needed. Complete configuration below before launching OMP; installation does not configure the provider or enable the memory backend.

## Install with git clone

Alternatively, clone into OMP's default-profile extensions directory. The extension is not published on npm:

```sh
mkdir -p "$HOME/.omp/agent/extensions"
git clone https://github.com/Razunter/hindsight-omp-extra.git "$HOME/.omp/agent/extensions/hindsight-omp-extra"
cd "$HOME/.omp/agent/extensions/hindsight-omp-extra"
```

The **extension root** is the installed package or clone, containing `package.json`, `src/`, and `.env.example`. No `bun install` or build is required. Complete setup before launching OMP. A clone in the native extensions directory makes the launcher discoverable automatically.

For a clone in a named profile or custom agent directory, use that extensions directory instead. [Configure the package directory](#load-persistently) so OMP also discovers the bundled skill.

The launcher stores `.env`, `providers/`, `.selected-provider`, `.local-management.json`, optional `credentials/`, and logs in the extension root. These files are Git-ignored in a clone. Keep the directory writable and back up local files before reinstalling, upgrading, replacing, or removing the package. Keep the same Docker volume name when restoring configuration.

## 2. Create local configuration

For a new installation, copy the root [`.env.example`](../.env.example) and one provider template. This block refuses overwrites and restricts permissions:

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

If a destination exists, edit it rather than rerun the block. The copies are not transactional: if the second fails, the first file may already exist.

Edit these files before launching:

- **`.env`:** choose the Docker container, named volume, image, worker settings, and API/dashboard ports. The example uses `hindsight-omp`, `hindsight-omp-data`, and ports `8888`/`9999`; change them if occupied. Both published ports bind to `127.0.0.1` by default. [Changing the bind address](configuration.md#network-binding) is explicit.
- **`providers/primary.env`:** replace the model and API-key placeholders with values authorized for Hindsight. Never copy OMP tokens or put shell variable references in this file: values are literal, not interpolated. For another provider, use the appropriate [provider template](configuration.md#copy-a-complete-example) instead.

The image example follows Hindsight’s [official Docker installation](https://hindsight.vectorize.io/developer/installation) and uses the rolling `latest` tag. For reproducible deployments, choose a tag or digest verified with your provider. Local management uses only an image already in Docker’s local cache and never downloads one, so pull it yourself before opting in:

```sh
docker pull ghcr.io/vectorize-io/hindsight:latest
```

Approval binds the cached image ID shown in the confirmation; a tag that moves later is not followed. A different Hindsight version may migrate the reused database, and replacing the image does not roll the database back. A named volume is not a backup.

Include only values intended for Hindsight. The validated merged configuration is forwarded to the container, including credentials and variables without a `HINDSIGHT_` prefix. Your AI provider may receive content for memory processing; self-hosting the database does not make remote inference offline.

For a fresh setup, save the profile name without launching OMP first:

```sh
(
    set -eu
    umask 077
    set -C
    printf 'primary\n' > .selected-provider
)
```

This refuses to overwrite an existing selection. For later switches, use `/hindsight` and choose **Provider configuration** in interactive OMP. It lists names, not credentials. With CPU management on, it then offers to apply the new configuration.

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

## 4. Opt in and verify

Start an interactive OMP process from the project whose memories you want to use:

```sh
omp
```

For a clone not yet [loaded persistently](#load-persistently), use `omp -e /absolute/path/to/hindsight-omp-extra` instead. Pass the package directory so the ingestion skill loads too.

Run `/hindsight`, choose **Mode**, then **CPU**. The extension validates the selected provider configuration, finds the cached image and shows one confirmation with the provider configuration, image ID, data volume and whether an existing container is replaced. Declining changes nothing; CPU stays requested and **Status** shows it as pending.

After you confirm, the cutover runs in the background, so OMP stays usable. An existing container keeps running until cutover, is stopped gracefully (up to 75 seconds) and set aside, and the new container starts on the same volume. Success is reported only after Hindsight’s `/health` endpoint reports a healthy API and a connected database. With the example ports:

```text
Hindsight: CPU runtime ready (API :8888, UI :9999)
```

That notification does not prove provider authentication; provider rejection or model incompatibility can still appear in the container’s Docker logs. The [Hindsight dashboard](http://127.0.0.1:9999) uses the example UI port. For errors, run `/hindsight` → **Status** and inspect `hindsight.log` in the extension root.

Only interactive main sessions manage the container. Headless OMP processes and subagents can use the evidence tool but never start or change Docker. Keep the server running before using those modes.

For an ingestion trial from the extension directory, follow [source ingestion](ingestion.md) and run:

```text
/skill:hindsight-ingest docs/architecture.md
```

A configured scout and active native `retain` tool are required. The skill reports what it queued or skipped; a queue acknowledgement is not confirmed server persistence. Evidence searches need retained material to find; an empty bank can legitimately return no results.

## Load persistently

Git installations already load the launcher and bundled skill in new sessions. For a clone, add its directory to the active OMP configuration's `extensions` list. For the default-profile clone above, preserve existing entries and add:

```yaml
extensions:
  - ~/.omp/agent/extensions/hindsight-omp-extra
```

Configure the package directory, not just `src/hindsight-omp.ts`, so OMP discovers `hindsight-ingest` too. No symlink is needed.

Restart OMP after deployment. Extension package settings arrays replace rather than append across configuration layers, so check the effective list if a project or overlay also supplies `extensions`.

## Apply configuration changes

Editing `.env`, a provider profile, or `.selected-provider` does not restart the container. With CPU management on, the change is pending: run `/hindsight` → **Apply requested configuration**, check the confirmation and approve it. The replacement reuses the named data volume and applies in the current OMP process. Startup never applies a pending change: it can start the stopped approved container, but does not recreate a missing one, and reports what needs applying.

The same rule applies to `HINDSIGHT_BIND_ADDRESS`: an already-running container keeps its old bindings until you apply the change.

Recall-footer and nudge settings are different: they are ordinary live OMP settings, documented in [recall guidance](recall.md).

## Upgrade from an earlier version

Earlier versions managed Docker automatically. Local management is now Off for existing installations too. On the first interactive start after upgrading, OMP shows one notice; nothing is stopped, deleted or rewritten, and your container, database, provider files, saved selection and credentials stay as they are. Evidence keeps using OMP’s native connection.

To keep using local management, run `/hindsight` → **Mode** → **CPU** and confirm. The first approval adopts the existing container with the configured name: it is stopped gracefully and replaced by a labelled container on the same volume. Automatic image pulls and the `.last-image-check` file are no longer used; you can delete that file. The old `/hindsight-provider` command is replaced by `/hindsight` → **Provider configuration**.

## Local management Off

Choosing **Mode** → **Off** takes effect immediately for every OMP process of this installation. It does not stop the container or delete images, volumes, provider files or credentials. Later startups do no Docker work, and **Status** reports only stored state.

## Stop the container

The container does not stop itself when OMP exits. With the example container name, stop it explicitly:

```sh
docker stop hindsight-omp
```

Use your configured `HINDSIGHT_CONTAINER_NAME` if different. This stops the container without deleting its named data volume. With CPU management on, the next fresh interactive OMP launch starts the approved container again; choose **Off** in `/hindsight` first to keep it stopped. The container uses Docker’s `unless-stopped` restart policy; closing OMP is not an instruction to stop Docker.

## Development checks

Run checks from the extension root:

```sh
bun run check
```

This runs the Bun test suite and bundles the extension into `.tmp/build`. Tests use synthetic configuration and fake Docker rather than your running Hindsight deployment.
