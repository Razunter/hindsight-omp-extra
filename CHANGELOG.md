# Changelog

## Unreleased

- Local Hindsight management is now opt-in and Off by default, including for existing installations, which get a one-time notice. Off does no Docker work and no provider-file validation, never stops the running container and leaves provider files, selection and credentials untouched. Evidence, recall guidance and ingestion work without local management.
- New `/hindsight` menu with Status, Mode (Off/CPU), Provider configuration and Apply requested configuration. It replaces `/hindsight-provider`, which is removed without an alias.
- Applying CPU management uses the locally cached image, shows one confirmation with the image ID and the shared-service cutover, then runs in the background in the current OMP process. The current container keeps running until a graceful stop (up to 75 seconds); the replacement reuses the same volume, credential mount, ports, bind address and worker identity, and counts as active only after `/health` reports a healthy API and connected database. A failed launch restores the previous container; a failed readiness check keeps it for a manual decision.
- With CPU management on, startup starts the stopped approved container or recreates a missing one from the approved cached image and configuration. Pending configuration, a missing image or an unrecognized container are reported, never applied.
- Lifecycle operations across OMP processes are coordinated through `.local-management.json` and revalidated before cutover.
- Removed automatic image pulls, the `.last-image-check` file, image cleanup after pulls, and automatic container recreation on configuration drift.

## 1.0.1

- Clarify and shorten the docs; recommend Git URL installation with `omp install`.

## 1.0.0

- Initial release.
