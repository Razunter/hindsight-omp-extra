# Changelog

## Unreleased

- Local Hindsight management is now opt-in and Off by default, including for existing installations, which get a one-time notice. Off does no Docker work and no provider-file validation, never stops the running container and leaves provider files, selection and credentials untouched. Evidence, recall guidance and ingestion work without local management.
- New `/hindsight` menu with Status, Mode (Off/CPU), Provider configuration, Apply requested configuration and Check for updates. It replaces `/hindsight-provider`, which is removed without an alias.
- Applying CPU management shows one confirmation with the exact image (cached image ID or `repository@digest` download), the configuration and the shared-service cutover, then runs in the background in the current OMP process. There is no download-only step. The current container keeps running during the download and until a graceful stop (up to 75 seconds); the replacement reuses the same volume, credential mount, ports, bind address and worker identity, and counts as active only after `/health` reports a healthy API and connected database. A failed launch restores the previous container; a failed readiness check keeps it and both images for a manual decision. A version change warns that the reused database may be migrated and that the old image is no rollback.
- First installations and updates download the approved target by registry digest after that approval: a first apply without a cached image checks the registry, and an available update or a missing approved image is offered through the same apply. A tag or check that moves after approval cannot change the applied image. Downloaded images are recorded as owned. After a healthy cutover the configured tag moves to the new image and the previous image is removed only when it has no tag and no container uses it, without force or prune; a cleanup failure is reported separately from readiness.
- With CPU management on, startup starts the stopped approved container or recreates a missing one from the approved cached image and configuration. Pending configuration, a missing image or an unrecognized container are reported, never applied.
- Update checks read the configured image's registry manifest digests with `docker buildx imagetools inspect`, without downloading layers, and compare them with the approved image's registry digests. With CPU management on, a fresh interactive start checks at most once per 24 hours across processes, failed attempts included; **Check for updates** checks immediately. Results (current, available with the exact target, failed, unsupported without Buildx) appear in Status and as nonmodal notifications. A check never downloads, applies or changes the requested or active runtime, and a digest-pinned reference is never moved.
- Lifecycle operations across OMP processes are coordinated through `.local-management.json` and revalidated before cutover.
- Removed automatic image pulls, the `.last-image-check` file and automatic container recreation on configuration drift.

## 1.0.1

- Clarify and shorten the docs; recommend Git URL installation with `omp install`.

## 1.0.0

- Initial release.
