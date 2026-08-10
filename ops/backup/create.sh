#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
  cat <<'USAGE'
Usage: ops/backup/create.sh DESTINATION_DIRECTORY

Create a coordinated AIQSA backup while the web app and standalone Memory
worker are stopped. The script restarts only services that were running before
the backup began and fences their durable Memory leases before copying data.

The destination receives one mode-0700 bundle containing:
  manifest.env   privacy-safe format/runtime metadata
  postgres.dump  PostgreSQL custom-format dump
  objects.tar    private MinIO bucket snapshot
  SHA256SUMS     checksums for all three artifacts

The normal Compose installation and its required environment must already be
configured. The script never removes Docker volumes or source data. Keep
completed bundles on encrypted, access-restricted storage and copy them off-host.
Retention and scheduling are intentionally operator-owned.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

[[ "$#" -eq 1 ]] || {
  usage >&2
  exit 2
}

require_command docker
require_command sha256sum
require_command tar

destination="$1"
if [[ ! -e "$destination" ]]; then
  mkdir -m 700 -p -- "$destination"
fi
[[ -d "$destination" && ! -L "$destination" ]] || die "Destination must be a real directory, not a symlink."
destination="$(cd -- "$destination" && pwd -P)"
[[ -w "$destination" ]] || die "Destination is not writable."

cd "$REPOSITORY_ROOT"

service_is_running postgres || die "postgres must be running before backup."
service_is_running minio || die "minio must be running before backup."
if ! compose run --rm --no-deps --entrypoint /bin/sh minio-init -ceu '
  : "${S3_ENDPOINT:?}"
  [ "$S3_ENDPOINT" = http://minio:9000 ]
' >/dev/null 2>&1; then
  die "This backup helper supports only the bundled MinIO endpoint; no service was stopped."
fi

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bundle_name="aiqsa-backup-$(date -u +%Y%m%dT%H%M%SZ)"
bundle="$destination/$bundle_name"
partial="$destination/.${bundle_name}.partial.$$"
objects_directory="$partial/.objects"
app_was_running=0
memory_worker_was_running=0

[[ ! -e "$bundle" && ! -e "$partial" ]] || die "Backup destination already exists."
mkdir -m 700 -- "$partial"

cleanup() {
  local status=$?
  trap - EXIT

  if [[ -d "${partial:-}" ]]; then
    if ! rm -rf -- "$partial"; then
      info "Error: an incomplete private backup directory could not be removed."
      status=1
    fi
  fi

  if [[ "$memory_worker_was_running" -eq 1 ]]; then
    if compose start memory-worker >/dev/null 2>&1 && service_is_running memory-worker; then
      info "memory-worker restarted."
    else
      info "Error: backup ended but memory-worker could not be restarted."
      status=1
    fi
  fi

  if [[ "$app_was_running" -eq 1 ]]; then
    if compose start app >/dev/null 2>&1 && service_is_running app; then
      info "app restarted."
    else
      info "Error: backup ended but app could not be restarted."
      status=1
    fi
  fi

  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

service_is_running app && app_was_running=1
service_is_running memory-worker && memory_worker_was_running=1

if [[ "$app_was_running" -eq 1 || "$memory_worker_was_running" -eq 1 ]]; then
  info "Stopping web and Memory writers for a write-quiesced backup..."
  compose stop app memory-worker >/dev/null
fi

if service_is_running app; then
  die "app is still running; backup was not started."
fi
if service_is_running memory-worker; then
  die "memory-worker is still running; backup was not started."
fi

info "Fencing durable Memory leases..."
if ! compose exec -T postgres sh -ceu '
  : "${POSTGRES_DB:?}"
  : "${POSTGRES_USER:?}"
  : "${POSTGRES_PASSWORD:?}"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" <<'"'"'SQL'"'"'
DO $memory_backup$
BEGIN
  IF to_regclass('"'"'public."MemoryJob"'"'"') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE "MemoryJob"
      SET
        "state" = '"'"'RETRYABLE_FAILED'"'"'::"MemoryJobState",
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "nextAttemptAt" = CURRENT_TIMESTAMP,
        "errorCode" = '"'"'memory_backup_fenced'"'"',
        "errorMessage" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "state" = '"'"'CLAIMED'"'"'::"MemoryJobState"
    $sql$;
  END IF;
  IF to_regclass('"'"'public."MemoryDeletionOutbox"'"'"') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE "MemoryDeletionOutbox"
      SET
        "state" = '"'"'RETRY_WAIT'"'"'::"MemoryDeletionState",
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "nextAttemptAt" = CURRENT_TIMESTAMP,
        "lastAuditAt" = CURRENT_TIMESTAMP,
        "errorCode" = '"'"'memory_backup_fenced'"'"',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "state" = '"'"'RUNNING'"'"'::"MemoryDeletionState"
    $sql$;
  END IF;
END
$memory_backup$;
SQL
' >/dev/null 2>&1; then
  die "Durable Memory lease fencing failed; backup was not started."
fi

memory_suppression_relation="$({
  compose exec -T postgres sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
      --command="SELECT to_regclass('"'"'public.\"MemorySuppression\"'"'"') IS NOT NULL"
  '
} 2>/dev/null)" || die "Could not inspect Memory suppression metadata."
memory_suppression_relation="${memory_suppression_relation//[[:space:]]/}"
[[ "$memory_suppression_relation" == "t" || "$memory_suppression_relation" == "f" ]] || die "PostgreSQL returned invalid Memory suppression metadata."

memory_key_ids=""
if [[ "$memory_suppression_relation" == "t" ]]; then
  memory_key_ids="$({
    compose exec -T postgres sh -ceu '
      : "${POSTGRES_DB:?}"
      : "${POSTGRES_USER:?}"
      : "${POSTGRES_PASSWORD:?}"
      export PGPASSWORD="$POSTGRES_PASSWORD"
      exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --command='"'"'SELECT COALESCE(string_agg(DISTINCT "fingerprintKeyVersion", '"'"'"'"'"','"'"'"'"'"' ORDER BY "fingerprintKeyVersion"), '"'"'"'"'"''"'"'"'"'"') FROM "MemorySuppression"'"'"'
    '
  } 2>/dev/null)" || die "Could not read Memory suppression key metadata."
  memory_key_ids="${memory_key_ids//$'\r'/}"
  memory_key_ids="${memory_key_ids//$'\n'/}"
fi
valid_memory_key_ids "$memory_key_ids" || die "PostgreSQL returned invalid Memory suppression key metadata."

info "Creating PostgreSQL dump..."
postgres_version="$({
  compose exec -T postgres sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
      --command="SHOW server_version_num"
  '
} 2>/dev/null)" || die "Could not read the PostgreSQL server version."
postgres_version="${postgres_version//$'\r'/}"
postgres_version="${postgres_version//$'\n'/}"
[[ "$postgres_version" =~ ^[0-9]{5,6}$ ]] || die "PostgreSQL returned an invalid server version."

if ! compose exec -T postgres sh -ceu '
  : "${POSTGRES_DB:?}"
  : "${POSTGRES_USER:?}"
  : "${POSTGRES_PASSWORD:?}"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
' >"$partial/postgres.dump" 2>/dev/null; then
  die "PostgreSQL dump failed; no backup bundle was published."
fi
chmod 600 "$partial/postgres.dump"

info "Creating private object snapshot..."
mkdir -m 700 -- "$objects_directory"
if ! compose run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --volume "$objects_directory:/snapshot" \
  --entrypoint /bin/sh \
  minio-init -ceu '
    umask 077
    : "${S3_ACCESS_KEY_ID:?}"
    : "${S3_BUCKET:?}"
    : "${S3_ENDPOINT:?}"
    : "${S3_SECRET_ACCESS_KEY:?}"
    [ "$S3_ENDPOINT" = http://minio:9000 ] || exit 19
    mc alias set --quiet source "$S3_ENDPOINT" \
      "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" \
      >/dev/null 2>&1 || exit 20
    mc stat "source/$S3_BUCKET" >/dev/null 2>&1 || exit 21
    mc mirror --quiet --overwrite "source/$S3_BUCKET" /snapshot \
      >/dev/null 2>&1 || exit 22
  ' >/dev/null 2>&1; then
  die "Private object snapshot failed. This helper supports only the bundled MinIO endpoint; no object names were logged and no backup bundle was published."
fi

if find "$objects_directory" -type l -print -quit | grep -q .; then
  die "Private object snapshot contains an unsupported symbolic link."
fi
if ! tar -C "$objects_directory" -cf "$partial/objects.tar" . 2>/dev/null; then
  die "Private object archive creation failed; no object names were logged."
fi
chmod 600 "$partial/objects.tar"
rm -rf -- "$objects_directory"

app_revision="${AIQSA_APP_REVISION:-}"
if [[ -z "$app_revision" ]]; then
  app_revision="$(git rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
fi
if [[ ! "$app_revision" =~ ^[0-9a-f]{40}$ ]]; then
  app_revision="unknown"
fi

cat >"$partial/manifest.env" <<MANIFEST
AIQSA_BACKUP_FORMAT=$AIQSA_BACKUP_FORMAT
CREATED_AT_UTC=$created_at
APP_REVISION=$app_revision
POSTGRES_SERVER_VERSION_NUM=$postgres_version
POSTGRES_DUMP_FORMAT=custom
OBJECT_ARCHIVE_FORMAT=tar
MEMORY_SUPPRESSION_KEY_IDS=$memory_key_ids
MANIFEST
chmod 600 "$partial/manifest.env"

(
  cd "$partial"
  sha256sum manifest.env postgres.dump objects.tar >SHA256SUMS
)
chmod 600 "$partial/SHA256SUMS"

validate_bundle "$partial"
mv -- "$partial" "$bundle"
partial=""

info "Backup completed: $bundle"
