# Deployment and updates

AIQSA uses the same Compose stack for a laptop, a private server, or a server behind HTTPS. The default installation is local-only and needs neither a domain nor an SMTP server.

## Local installation

Follow the [README quick start](../README.md#quick-start). The application is published at `127.0.0.1:3000`; PostgreSQL and MinIO stay on the internal Compose network.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:3000/api/health/ready
```

## Running on a server

The minimum requirement is a Linux server with Docker Engine and the Docker Compose plugin. A domain, HTTPS reverse proxy, SMTP account, Google OAuth, and Yandex OAuth are optional additions. A publicly reachable installation should use a domain and HTTPS.

1. Clone the repository and create `.env` as described in [configuration](configuration.md).
2. For HTTPS, set `AIQSA_APP_BASE_URL=https://aiqsa.example.com`, `AIQSA_COOKIE_SECURE=1`, and keep `AIQSA_BIND_ADDRESS=127.0.0.1`.
3. Start the stack with the same command used locally:

   ```bash
   docker compose up -d --build
   ```

4. Point a reverse proxy at `http://127.0.0.1:3000` and issue a TLS certificate. The repository includes an [Nginx starting point](../ops/nginx/README.md); replace its example domain and port with `AIQSA_PORT` before enabling it.
5. Check `/api/health/ready`, sign in as the initial administrator, and send one small question through each provider/search path you intend to use.

If the proxy overwrites forwarding headers and is the only trusted hop, enable:

```dotenv
AIQSA_TRUST_PROXY_HEADERS=1
AIQSA_TRUSTED_PROXY_COUNT=1
```

Do not publish the database or object-storage service ports. If you intentionally bind AIQSA directly to a LAN address without HTTPS, update `AIQSA_APP_BASE_URL`, `AIQSA_BIND_ADDRESS`, and `AIQSA_COOKIE_SECURE` together and protect access with the host firewall.

## Data persistence

The default stack stores PostgreSQL and MinIO data in the externally named volumes `aiqsa_postgres_data` and `aiqsa_minio_data`. These commands preserve them:

```bash
docker compose stop
docker compose down
docker compose up -d --build
```

`docker compose down -v` deletes those volumes and therefore the installation data. `AIQSA_POSTGRES_VOLUME_NAME` and `AIQSA_MINIO_VOLUME_NAME` can point a migrated installation at existing live volume names; leave them unset for a fresh installation.

## Backups

Create a coordinated database and object backup before updates that may apply migrations:

```bash
ops/backup/create.sh /secure/aiqsa-backups
```

The backup script briefly stops the application writer, captures PostgreSQL and the private bundled MinIO bucket, verifies checksums, and starts the application again if it was previously running. It deliberately fails for an external S3 endpoint; use that provider's consistent backup/versioning procedure together with the PostgreSQL backup instead. Store completed bundles on encrypted, access-restricted storage and copy them off the host.

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
docker compose up -d --build
docker compose ps
```

The one-shot startup job applies committed migrations and safely adopts an existing installation before the application becomes ready. Existing users, chats, settings, and uploaded objects remain in the named volumes.

Afterward, check readiness and one real provider path:

```bash
curl -fsS http://127.0.0.1:3000/api/health/ready
```

Review release notes before large version jumps. Never replace a backup with an unverified copy or delete the old volumes until the updated installation has been validated.
