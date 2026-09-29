# Upgrading from MinIO

AIQSA releases up to v0.2.30 stored files in a bundled MinIO service. Later releases bundle SeaweedFS instead. An existing installation copies its stored files into SeaweedFS once with `scripts/migrate-minio-to-seaweedfs.sh`. This page is written so that a person or an agent can follow it step by step: run each command, compare the result with the expected result, and stop when a stop condition applies.

## Who needs this

You need this procedure if your installation was started with a release that used MinIO. You do not need it if:

- the installation is new;
- `.env` sets `AIQSA_S3_ENDPOINT` to external S3 storage.

A typical sign is this error from `docker compose pull`:

```
pull access denied for minio/mc
```

It means the Compose file is older than the release. Docker Hub no longer serves the MinIO images, so update the checkout first (step 3).

## What the procedure does

The script uses only the Docker CLI with your own permissions. It never runs `docker compose down`, never removes volumes or images, and never writes application data into the old MinIO storage. It runs in this order:

1. It checks everything read-only (the preflight). A failure at this stage changes nothing.
2. It gives the cached MinIO image a local tag, `aiqsa-legacy-minio:<project>`, so image cleanup cannot remove it during the transition.
3. It stops the stack with `docker compose stop`. Containers from override files are stopped and kept.
4. It starts PostgreSQL and SeaweedFS and applies database migrations.
5. It starts a read-only MinIO reader (`minio-legacy`) on a private network, using the MinIO image already cached on this host.
6. It marks unfinished browser uploads of Knowledge files as needing a retry. Users select those files again after the upgrade.
7. It copies every object and verifies the key, size, SHA-256 and content type. Only after verification does it write a completion marker.
8. It removes the reader and starts the whole stack.

Downtime is about two minutes for stopping and starting services, plus the copy. The copy grows with the amount of stored data: every object is read once to copy it and once more to verify it.

The application stays stopped until the marker exists. If you skip the script, the new `storage-init` service refuses to start the application on an empty store.

## Before you start

1. Plan a maintenance window and tell your users. Uploads that are still in progress when the stack stops must be restarted afterwards.
2. Back up PostgreSQL and the MinIO volume with your usual backup tooling.
3. Work in the checkout directory as a user who can run `docker` commands.

Requirements:

- Docker Compose 2.29.7 or newer.
- The MinIO image that the installation already uses, still present on this host. It can no longer be downloaded.
- Free disk space on the Docker data volume of at least the size of the MinIO data, plus 10%, plus 1 GiB. The dry run checks this.

## Procedure

Run every command from the AIQSA checkout.

1. Check that tracked files are unmodified.

   ```sh
   git status --short --untracked-files=no
   ```

   Expected: no output.

   Stop if files are listed: move your changes into `compose.override.yaml` or `.env`, then repeat this step.

2. Check that the migration profile is not active.

   ```sh
   printenv COMPOSE_PROFILES; grep '^COMPOSE_PROFILES=' .env
   ```

   Expected: no output, or a list that does not contain `storage-migration`.

   Stop if `storage-migration` appears: remove it from the environment and from `.env`.

3. Update the checkout to the new release.

   ```sh
   git pull --ff-only
   ```

   Expected: `Fast-forward` or `Already up to date.`

   Stop on any other result.

4. Download the new images.

   ```sh
   docker compose pull
   ```

   Expected: exit status 0. No MinIO image is downloaded.

   Stop on an error. `pull access denied for minio/mc` means step 3 did not update the Compose file.

5. Run the read-only check.

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh --dry-run
   ```

   Expected: exit status 0 and a numbered line `Dry run complete: preflight passed and nothing was changed`.

   Write down the two names the script prints:
   - `Legacy MinIO data` (the old storage);
   - `New SeaweedFS data` (the new volume).

   If the script prints `Already migrated`, skip to step 7.

   Stop on `FAILED (exit N)`: apply the remedy from the [exit code table](#exit-codes), then repeat this step. The dry run changes nothing.

6. Migrate.

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh
   ```

   Expected:
   - the script prints numbered steps and periodic `storage-migrate: progress` lines;
   - a `storage-migrate: completed` line reports the copied objects;
   - a numbered line `Migration complete` follows, then the two storage names again, with exit status 0.

   Stop on `FAILED (exit N)`: apply the remedy from the table, then run this step again. A repeated run continues from where the last one stopped and does not copy verified objects again.

7. Check the completion marker.

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh status
   ```

   Expected, with exit status 0:
   - `marker=valid`;
   - `marker_source=migrated` (or `fresh` for an installation that never stored files);
   - `objects=` equal to `migrated_objects=`.

   Stop on any other result: see the table.

8. Start the stack and check it.

   ```sh
   docker compose up -d
   docker compose ps
   ```

   Expected:
   - `app` reports `healthy` (this can take about a minute);
   - `storage-init` has exited with status 0;
   - `minio-legacy` is not listed.

   Sign in and open a few existing attachments and Knowledge documents.

   Stop if `app` does not become healthy: run `docker compose logs storage-init app`, then see the [troubleshooting section](#troubleshooting).

9. Point your backups at the new volume.

   Back up the `New SeaweedFS data` name from step 5, together with PostgreSQL. The `Legacy MinIO data` no longer changes.

10. Review overrides of the storage service.

    ```sh
    docker compose config --format json minio
    ```

    Expected: a relay service using the application image. It has no `/data` mount.

    Settings from an old override still apply to this relay, for example a published port for a browser-reachable S3 endpoint. MinIO-specific settings, such as environment variables, a console port or an image, no longer apply: remove them from `compose.override.yaml`. The SeaweedFS engine runs in the `seaweedfs` service.

## Exit codes

A refusal before step 3 of the script (tagging the image) changes nothing. A failure during the run leaves the application stopped and the MinIO reader in place. Fix the cause, then run the same command again.

| Exit | Meaning | Remedy |
| --- | --- | --- |
| 0 | Success, or already migrated. | None. |
| 2 | Unknown arguments. | Use `--dry-run`, `status` or no argument. |
| 10 | Docker is unreachable, or Docker Compose is older than 2.29.7. | Run as a user allowed to use Docker, or upgrade Docker Compose. |
| 11 | The Compose configuration is invalid or outdated, or the application image is missing. | Run from the checkout, then `git pull --ff-only` and `docker compose pull`. |
| 12 | `COMPOSE_PROFILES` contains `storage-migration`. | Remove it from the environment and from `.env`. |
| 13 | The application uses an external S3 endpoint. | Nothing to migrate: run `docker compose up -d`. |
| 14 | The mounts do not match. The MinIO data is not where the `minio-legacy` and `storage-init` services would mount it, or an override still maps a `/data` path into the `minio` service. | See [Overrides](#overrides). |
| 15 | The legacy data is missing, empty, unreadable or has an unknown layout. | Check `COMPOSE_PROJECT_NAME` and your overrides: they must name the project and volume that the old installation used. Nothing was changed. |
| 16 | The pinned MinIO image is not present on this host. | Copy it from a host that has it: `docker save <image> \| ssh <this host> docker load`, using the image the script names. Then rerun. |
| 17 | Not enough free disk space. | Free space on the Docker data volume and rerun. If the new volume is on a bind mount, create that directory first. |
| 18 | The legacy bucket uses versioning, encryption, object lock or a public policy, or its settings could not be read. The bundled release never configures these, so the copy would not be exact. | Stop and restore the bucket to its default private settings, or keep this installation on external S3 storage. Nothing was changed. |
| 19 | The new storage holds a marker that is invalid, belongs to another installation, or comes from before a rollback. | See [Migrating again after a rollback](#migrating-again-after-a-rollback). Otherwise, check which project and volumes this checkout uses. |
| 20 | Stopping the stack failed, or a container still uses the legacy data or object storage. | Stop those containers (`docker ps` lists them), then rerun. |
| 21 | SeaweedFS did not become healthy. | Check `docker compose logs seaweedfs minio`, then rerun. |
| 22 | Database migrations failed. | Check the output above, then rerun. |
| 23 | The MinIO reader did not become healthy. | Check `docker compose --profile storage-migration logs minio-legacy`, then rerun. |
| 24 | Copying or verification did not finish. No marker was written. | Fix the cause named in the `storage-migrate: failed` line, for example free disk space, then rerun. The next run resumes. |
| 25 | The stack did not start after a successful copy. | Check `docker compose logs storage-init app`, then run `docker compose up -d`. |
| 30 | `status` found no completion marker. | The migration has not finished: run step 6. |
| 31 | `status` found an invalid or foreign marker, or the storage service is not running. | Start it with `docker compose up -d minio` and repeat. For a foreign marker, see exit 19. |

## Overrides

Earlier releases had no `seaweedfs` service. An override that customized MinIO therefore affected the `minio` service.

If `compose.override.yaml` pointed the `minio` service's `/data` at another volume or a host directory, remove that mapping from `minio`. Then map the same source into the two services that read the old data:

```yaml
services:
  minio-legacy:
    volumes: !override
      - /srv/aiqsa/minio:/data
  storage-init:
    volumes: !override
      - /srv/aiqsa/minio:/legacy:ro
```

To store the new data elsewhere, map `/data` of the `seaweedfs` service. It must be a location different from the old MinIO data.

Then repeat the dry run.

## After the migration

The old MinIO data and the MinIO image stay on the host until you remove them. To keep a copy of the image elsewhere:

```sh
docker save aiqsa-legacy-minio:<project> -o aiqsa-legacy-minio.tar
```

When you are satisfied with the result, and backups of the new volume are in place, remove the old data yourself:

```sh
docker volume rm <Legacy MinIO data>
docker image rm aiqsa-legacy-minio:<project>
```

If the script reported an exited `minio-init` container from the old release, remove it with the `docker rm` command it printed.

## Rolling back

Roll back only if nobody has used the application since the migration. Anything written to the new storage after the migration is lost on rollback.

1. Check that the stored objects are unchanged.

   ```sh
   sh scripts/migrate-minio-to-seaweedfs.sh status
   ```

   Continue only if `objects=` equals `migrated_objects=`, and you know that nobody uploaded or deleted files.

2. Return to the previous release. The old MinIO data is untouched.

   ```sh
   docker compose stop
   git checkout <previous release tag>
   docker compose up -d --remove-orphans
   ```

   `--remove-orphans` removes the SeaweedFS containers. Their volume stays.

   The old release also needs its `minio/mc` image, which the script does not keep. It must still be cached on the host.

If the new volume is lost later, restore it from your backup. Running the migration again would bring back only the data from before the migration.

### Migrating again after a rollback

After a rollback, MinIO holds the newest data again. The new volume still holds the earlier copy, so the script refuses with exit 19.

Before migrating again, remove that earlier copy:

```sh
docker volume rm <New SeaweedFS data>
```

Then follow the procedure from step 3.

## Troubleshooting

`storage-init` stops the application with one of these messages in `docker compose logs storage-init`:

- `storage_migration_required`: data exists but has not been migrated. Run the procedure.
- `storage_target_unmarked`: an earlier migration did not finish. Run step 6 again.
- `storage_marker_foreign` or `storage_marker_invalid`: the storage does not belong to this Compose project. Check `COMPOSE_PROJECT_NAME` and your volumes.
- `storage_legacy_layout_unknown`: the old volume holds something other than MinIO data. Check your overrides.
