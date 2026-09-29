# Upgrading from MinIO to SeaweedFS

This procedure is for existing installations using bundled MinIO. New installations and installations using an external `AIQSA_S3_ENDPOINT` do not need migration. Run all commands from the installation directory, keeping its existing `.env`, Compose overrides, and project name.

## Before you start

- Schedule a maintenance window and keep users out until verification is complete. Finish ongoing uploads: incomplete multipart uploads will need to be restarted.
- Take a consistent backup of PostgreSQL and MinIO with the application and background writers stopped; keep them stopped until migration. Separately save `.env`, overrides, the current release, and the image digest for rollback.
- You need Docker Compose ≥ 2.29.7, the MinIO image still cached on the host, and free disk space equal to the old storage size + 10% + 1 GiB. Do not delete old images or volumes.
- If overrides changed the `minio` service's `/data` mount, remove that mount from `minio` and mount **the same source** at `minio-legacy:/data` and `storage-init:/legacy:ro`. The new `seaweedfs:/data` must use separate storage. Remove MinIO-specific `image`/`command` overrides: `minio` is now an S3 relay.
- Do not enable the `storage-migration` profile in `COMPOSE_PROFILES`.

## Procedure

1. Wait until the release containing SeaweedFS and its images are published. Replace `vX.Y.Z` below with the agreed release tag. **Do not run the usual `docker compose up -d` before migration.**

   ```sh
   git fetch origin --tags
   git switch --detach vX.Y.Z
   ```

   Match the images to this release: set `AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:X.Y.Z` in `.env` for the main image (without the `v`). If other images are pinned to older versions in `.env` or overrides, update them using the image references/digests in the release notes. Preserve all other settings and secrets.

   ```sh
   docker compose pull
   sh scripts/migrate-minio-to-seaweedfs.sh --dry-run
   ```

   Continue only after a successful dry run. Record the names printed as `Legacy MinIO data` and `New SeaweedFS data`. On failure, follow the printed `Next step` and repeat the check.

2. Run the migration:

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh
   ```

   The script stops the stack, applies database migrations, copies objects while verifying size, SHA-256, and ContentType, writes a completion marker, and starts the stack. The old storage is retained. Expect `Migration complete` and exit code `0`.

3. Check the marker:

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh status
   ```

   A migrated installation should report `marker=valid`, `marker_source=migrated`, and `migrated_missing_references=0`. Otherwise, stop the stack (`docker compose stop`) and investigate before allowing users back in.

4. Complete the switch, including after an interrupted run that already wrote the marker:

   ```sh
   docker compose --profile storage-migration rm -sf minio-legacy
   docker compose up -d
   docker compose ps -a
   ```

   Verify that `app` is `healthy`, `storage-init` is `Exited (0)`, and `minio-legacy` is absent. Open several existing attachments and Knowledge documents; upload and download a new small file. Then allow users back in.

5. Update your backups to cover **New SeaweedFS data together with PostgreSQL**. Retain the old MinIO storage until you have verified the new backups.

## If something fails

- Copy failure: fix the cause and rerun the script. Objects already copied are verified before being skipped. Do not delete the new volume to "start over."
- `Already migrated` confirms that a marker exists, but does not confirm that the application is running: complete steps 3–5.
- `storage_migrate_source_empty_with_references`: the current script may refuse an empty bucket with incomplete uploads. Do not delete database references; report the error to the maintainer so the migration can be fixed.
- Invalid/foreign marker, missing image, or mismatched mounts: stop and check the project, overrides, and old storage. Do not bypass the checks.
- The script migrates a standard private bucket without versioning, encryption, or object lock. If these settings cause a refusal, agree on a separate procedure; do not disable protections just to pass the check.
- For diagnostics, run `docker compose logs storage-init seaweedfs minio app`. Redact private data before sharing logs.

## Rollback

First stop the current stack: `docker compose --profile storage-migration stop`. Use the previous release and image identified by the saved digest, the consistent database and MinIO backup, and the saved `.env` and overrides. Switching back to the old MinIO does not transfer new data from SeaweedFS. If any writes occurred after migration, first agree on how to preserve them; do not start the old installation against the current database or delete either storage location.
