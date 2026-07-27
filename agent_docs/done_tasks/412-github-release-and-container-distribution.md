# 412-github-release-and-container-distribution

Status: done
Completed: 2026-07-27
Depends on: none

## Goal

Publish AIQSA releases and one GHCR image with a simple latest-first install path

## Scope

- Consolidate the application, migration/bootstrap, and maintenance commands into one non-root release image.
- Make the default installation consume `ghcr.io/insciqq/aiqsa:latest` through one optional `AIQSA_IMAGE` setting while preserving the separate disposable development stack.
- Add one tag-driven GitHub Actions workflow that publishes stable SemVer, `latest`, and commit tags for `linux/amd64` and `linux/arm64`, then creates the matching GitHub Release.
- Refresh public installation/update documentation, release contracts, repository presentation, and GitHub metadata for the public release repository.
- Publish and verify the first stable `v0.1.0` release.

## Out Of Scope

- Unrelated product changes, provider calls, broad CI matrices, a documentation site, and a self-hosted Actions runner.
- Changing the private GitLab development-remote role.

## Acceptance Criteria

- `app`, `migrate-bootstrap`, and `mcp-maintenance` use one `AIQSA_IMAGE` reference and retain their existing command and persistence behavior.
- A normal installation defaults to the public `latest` image and can pin one SemVer image in the existing `.env`; source development remains isolated in `docker-compose.dev.yml`.
- Pushing a stable `v*` tag builds one multi-platform GHCR package, assigns exact/version-line/`latest`/commit tags to the same release image, and creates a GitHub Release.
- The release image is non-root, contains the required migration/bootstrap/maintenance commands, and passes one fresh disposable installation smoke.
- The public repository has current metadata, an accurate screenshot/README, a visible GHCR package, and a published `v0.1.0` release.

## Tests

- `npm run docs:check`.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.
- Build the unified release image and run a fresh disposable installation smoke with unique image and volume names.
- Inspect the published GHCR manifest/tags and GitHub Release after Actions completes.

## Done Notes

- Consolidated the standalone app and pruned Prisma/bootstrap/maintenance tooling in one non-root `release` image; all installation roles now resolve the same `AIQSA_IMAGE`, defaulting to `ghcr.io/insciqq/aiqsa:latest` from the existing `.env`.
- Added the tag-driven GitHub workflow, ADR 0035, image-first install/update documentation, README badges, contribution/security policies, and public repository metadata. GitLab remains the private development remote and GitHub remains the curated public release remote.
- Fixed fresh installation bootstrap preflight so the code-owned `gemini-google-search` row inserted by the append-only migration is not mistaken for foreign application data.
- Published [v0.1.0](https://github.com/insciqq/AIQSA/releases/tag/v0.1.0) from commit `a6222f7f8f3a6151ab8e6faa71eb92402e5eeff6`; [Actions run 30275360114](https://github.com/insciqq/AIQSA/actions/runs/30275360114) completed successfully.
- Public GHCR tags `0.1.0`, `0.1`, `latest`, and `sha-a6222f7` all resolve to `sha256:9e20857bbb59a2d15a4c529ebba4742df6fff85b176efc9d45fa63fe9ecad7a8`, with `linux/amd64` and `linux/arm64` manifests. Anonymous pull, OCI source/revision labels, UID 1000, web entrypoint, Prisma, and tsx were verified.
- Checks: `npm run docs:check`; focused bootstrap test (9 passed); full `docker compose -f docker-compose.dev.yml exec -T app npm run check` (310 files / 2576 tests passed, 2 files / 14 tests skipped); local `release` build; fresh and adopted disposable installation smoke with unique image/project/volume names; readiness, database-row and MinIO-object preservation, shared image ID, and MCP maintenance dry-run. The explicitly named disposable project and its three test volumes were removed afterward.
