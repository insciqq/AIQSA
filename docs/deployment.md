# Deployment and updates

AIQSA uses the same Compose stack for a laptop, a private server, or a server behind HTTPS. The default installation is local-only and needs neither a domain nor an SMTP server. The stack also includes a pinned ToolHive controller for administrator-managed local MCP workloads.

## Local installation

Follow the [README quick start](../README.md#quick-start). The application is published at `127.0.0.1:3000`; PostgreSQL and MinIO stay on the internal Compose network.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:3000/api/health/ready
```

## Running on a server

The minimum requirement is a Linux server with Docker Engine and the Docker Compose plugin. SMTP, Google OAuth, and Yandex OAuth are optional. A non-loopback or publicly reachable installation requires a trusted reverse proxy; public access should use a domain and HTTPS.

1. Clone the repository and create `.env` as described in [configuration](configuration.md).
2. For HTTPS, set `AIQSA_APP_BASE_URL=https://aiqsa.example.com`, `AIQSA_COOKIE_SECURE=1`, and keep `AIQSA_BIND_ADDRESS=127.0.0.1`.
3. Start the stack with the same command used locally:

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. Point a reverse proxy at `http://127.0.0.1:3000` and issue a TLS certificate. The repository includes an [Nginx starting point](../ops/nginx/README.md); replace its example domain and port with `AIQSA_PORT` before enabling it.
5. Check `/api/health/ready`, sign in as the initial administrator, and send one small question through each provider/search path you intend to use.

The bundled proxy overwrites forwarding headers and delivers one exact client entry, so enable:

```dotenv
AIQSA_TRUST_PROXY_HEADERS=1
AIQSA_TRUSTED_PROXY_COUNT=1
```

Do not publish the database, object-storage, ToolHive control, or MCP proxy ports. Direct non-loopback publication is not a supported authentication transport boundary: readiness rejects a non-loopback base URL without declared trusted forwarding identity. Keep AIQSA loopback-bound and expose only the proxy.

ToolHive uses the host Docker socket to create separate sibling containers for npm, PyPI, and OCI stdio MCP servers. Only the ToolHive service receives the socket; the application and MCP workloads do not. Socket access is nevertheless root-equivalent host authority, and AIQSA can reach ToolHive's full unauthenticated API on their private internal network. Restrict host and Docker access, keep the pinned image, and treat administrator-installed MCP code plus its ordinary outbound network access as trusted. Remote Streamable HTTP MCPs run through AIQSA and do not create a ToolHive workload.

## Data persistence

The default stack stores PostgreSQL, MinIO, and disposable ToolHive state in the externally named volumes `aiqsa_postgres_data`, `aiqsa_minio_data`, and `aiqsa_toolhive_data`. These commands preserve them:

```bash
docker compose stop
docker compose down
docker compose up -d
```

`docker compose down -v` deletes those volumes and therefore the installation data. It still does not reliably delete dynamic sibling MCP containers because they are not Compose project members. Before uninstalling, changing `AIQSA_ENCRYPTION_KEY`, or abandoning a host, preview and then execute exact-marker cleanup:

```bash
docker compose run --rm mcp-maintenance
docker compose run --rm mcp-maintenance --execute
```

`AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, and `AIQSA_TOOLHIVE_VOLUME_NAME` can point a migrated installation at existing live volume names; leave them unset for a fresh installation. Normal startup/activity reconciliation repairs or drains AIQSA-owned MCP workloads after restarts.

## Backups

Create a coordinated database and object backup before updates that may apply migrations:

```bash
ops/backup/create.sh /secure/aiqsa-backups
```

The backup script briefly stops the application writer, captures PostgreSQL and the private bundled MinIO bucket, verifies checksums, and starts the application again if it was previously running. It deliberately fails for an external S3 endpoint; use that provider's consistent backup/versioning procedure together with the PostgreSQL backup instead. Store completed bundles on encrypted, access-restricted storage and copy them off the host.

Back up `AIQSA_ENCRYPTION_KEY` separately: the database copy cannot recover MCP shared/personal credentials or OAuth tokens without it. ToolHive state and generated local images are not authoritative backup data. Active revisions can be reconciled while their exact image remains cached; loss of a ToolHive-generated package image makes rollback best-effort and requires an explicit MCP rebuild/activation.

Verify a bundle without contacting Docker:

```bash
ops/backup/restore.sh --verify-only /secure/aiqsa-backups/aiqsa-backup-TIMESTAMP
```

A full restore intentionally accepts only explicitly named disposable services. Read `ops/backup/restore.sh --help`, restore into an isolated target, validate it, and perform an operator-controlled cutover; the script never overwrites the live database or bucket.

## Updating AIQSA

The commands below assume the checkout already uses the current persistent
default stack. When adopting data from an older profile-based Compose layout,
first make a verified backup while still on the old checkout. Then stop and
remove the old topology without deleting volumes (for the former profile this
is `docker compose --profile prod down`, never add `-v`). Confirm that no old
PostgreSQL or MinIO container remains attached, set
`AIQSA_POSTGRES_VOLUME_NAME` and `AIQSA_MINIO_VOLUME_NAME` to the existing live
volume names, and migrate the environment values to the canonical names in
[configuration](configuration.md) before starting the current stack. Never
mount one PostgreSQL data volume in old and new database containers at the same
time, and do not start a new empty database and assume the old data was
migrated.

From the existing checkout:

```bash
ops/backup/create.sh /secure/aiqsa-backups
git pull --ff-only
docker compose pull
docker compose up -d
docker compose ps
```

The one-shot startup job from the same release image applies committed migrations and safely adopts an existing installation before the application becomes ready. Existing users, chats, settings, and uploaded objects remain in the named volumes. The default `AIQSA_IMAGE` follows `latest`; set it in the existing `.env` to a version tag such as `ghcr.io/insciqq/aiqsa:X.Y.Z` when you prefer explicit upgrades.

Afterward, check readiness and one real provider path:

```bash
curl -fsS http://127.0.0.1:3000/api/health/ready
```

Review release notes before large version jumps. Never replace a backup with an unverified copy or delete the old volumes until the updated installation has been validated.
