#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
  cat <<'USAGE'
Usage:
  ops/backup/restore.sh --verify-only BACKUP_BUNDLE
  COMPOSE_FILE=ops/backup/docker-compose.restore.yml \
  COMPOSE_PROJECT_NAME=aiqsa-restore-UNIQUE \
  AIQSA_RESTORE_DISPOSABLE_TARGET=YES \
  AIQSA_RESTORE_POSTGRES_SERVICE=postgres-restore \
  AIQSA_RESTORE_MINIO_SERVICE=minio-restore \
  AIQSA_RESTORE_TOOLS_SERVICE=restore-tools \
  AIQSA_RESTORE_BUCKET=aiqsa-restore \
  AIQSA_RESTORE_REVIEW_DIRECTORY=/secure/aiqsa-restore-review \
    ops/backup/restore.sh BACKUP_BUNDLE

Restore accepts only a unique aiqsa-restore-* Compose project containing the
explicitly named database/object targets and a stopped one-shot tools role. No
other service may be running. The target PostgreSQL database, target MinIO
bucket, and private review directory must be empty. Canonical installation
service names are rejected even when the acknowledgement is set.

Provision the disposable services with ops/backup/docker-compose.restore.yml,
restore, reapply any external post-backup deletion journal, and run review.sh.
Only its promotion receipt permits an operator-controlled cutover. This script
never starts the app, drops a database, deletes a bucket, removes a Docker
volume, or enables external networking.

--verify-only checks bundle structure, format, checksums, dump header, and object
archive readability without contacting Docker.
USAGE
}

verify_only=0
case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --verify-only)
    verify_only=1
    shift
    ;;
esac

[[ "$#" -eq 1 ]] || {
  usage >&2
  exit 2
}

require_command sha256sum
require_command tar

bundle="$1"
validate_bundle "$bundle"
bundle="$(cd -- "$bundle" && pwd -P)"
info "Backup bundle verification passed."

if [[ "$verify_only" -eq 1 ]]; then
  exit 0
fi

[[ "${AIQSA_RESTORE_DISPOSABLE_TARGET:-}" == "YES" ]] || die "Set AIQSA_RESTORE_DISPOSABLE_TARGET=YES for an explicitly disposable target."

postgres_service="${AIQSA_RESTORE_POSTGRES_SERVICE:-}"
minio_service="${AIQSA_RESTORE_MINIO_SERVICE:-}"
tools_service="${AIQSA_RESTORE_TOOLS_SERVICE:-restore-tools}"
target_bucket="${AIQSA_RESTORE_BUCKET:-}"
review_directory="${AIQSA_RESTORE_REVIEW_DIRECTORY:-}"

[[ -n "$postgres_service" ]] || die "Set AIQSA_RESTORE_POSTGRES_SERVICE to a disposable service."
[[ -n "$minio_service" ]] || die "Set AIQSA_RESTORE_MINIO_SERVICE to a disposable service."
[[ -n "$target_bucket" ]] || die "Set AIQSA_RESTORE_BUCKET to a disposable bucket."
[[ -n "$review_directory" ]] || die "Set AIQSA_RESTORE_REVIEW_DIRECTORY to an empty private directory."
valid_service_name "$postgres_service" || die "Disposable PostgreSQL service name is invalid."
valid_service_name "$minio_service" || die "Disposable MinIO service name is invalid."
valid_service_name "$tools_service" || die "Disposable restore tools service name is invalid."
valid_bucket_name "$target_bucket" || die "Disposable MinIO bucket name is invalid."

case "$postgres_service" in
  postgres|app|memory-worker|minio|migrate-bootstrap|minio-init|restore-tools|*-p[r]od)
    die "Canonical application services cannot be restore targets."
    ;;
esac
case "$minio_service" in
  postgres|app|memory-worker|minio|migrate-bootstrap|minio-init|restore-tools|*-p[r]od)
    die "Canonical application services cannot be restore targets."
    ;;
esac
case "$tools_service" in
  postgres|app|memory-worker|minio|migrate-bootstrap|minio-init|*-p[r]od)
    die "Canonical application services cannot be restore tools."
    ;;
esac
[[ "$postgres_service" != "$minio_service" && "$postgres_service" != "$tools_service" &&
  "$minio_service" != "$tools_service" ]] || die "Restore services must be distinct."

require_command docker
require_command find
require_command stat
cd "$REPOSITORY_ROOT"

[[ -d "$review_directory" && ! -L "$review_directory" ]] ||
  die "Restore review directory must already exist and must not be a symlink."
review_directory="$(cd -- "$review_directory" && pwd -P)"
[[ "$(stat -c %a "$review_directory")" == "700" ]] ||
  die "Restore review directory must have mode 0700."
if find "$review_directory" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  die "Restore review directory must be empty; nothing was changed."
fi

assert_isolated_restore_project "$postgres_service" "$minio_service" "$tools_service"

service_is_running "$postgres_service" || die "Disposable PostgreSQL service is not running."
service_is_running "$minio_service" || die "Disposable MinIO service is not running."

postgres_query() {
  local sql="$1"

  compose exec -T "$postgres_service" sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"
  ' sh "$sql"
}

info "Preflighting disposable restore targets..."
target_postgres_version="$(postgres_query 'SHOW server_version_num' 2>/dev/null)" || die "Could not query the disposable PostgreSQL target."
target_postgres_version="${target_postgres_version//$'\r'/}"
target_postgres_version="${target_postgres_version//$'\n'/}"
[[ "$target_postgres_version" =~ ^[0-9]{5,6}$ ]] || die "Disposable PostgreSQL target returned an invalid version."
source_postgres_major=$((BACKUP_POSTGRES_VERSION_NUM / 10000))
target_postgres_major=$((target_postgres_version / 10000))
[[ "$source_postgres_major" -eq "$target_postgres_major" ]] || die "Backup and disposable PostgreSQL target major versions differ."

archive_listing="$({
  compose exec -T "$postgres_service" pg_restore --list <"$bundle/postgres.dump"
} 2>/dev/null)" || die "PostgreSQL archive is incompatible with the disposable target tools."
validate_current_schema_archive_listing "$archive_listing" ||
  die "PostgreSQL archive does not contain the current schema; nothing was changed."

target_relation_count="$(postgres_query "
  SELECT count(*)
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
" 2>/dev/null)" || die "Could not inspect the disposable PostgreSQL target."
target_relation_count="${target_relation_count//[[:space:]]/}"
[[ "$target_relation_count" =~ ^[0-9]+$ ]] || die "Disposable PostgreSQL target returned an invalid emptiness result."
[[ "$target_relation_count" -eq 0 ]] || die "Disposable PostgreSQL target is not empty; nothing was changed."

info "Preflighting Memory suppression keys..."
if ! compose run --rm --no-deps --env HOME=/tmp --entrypoint npm "$tools_service" \
  run memory:suppression:preflight -- restore \
  "$BACKUP_MEMORY_SUPPRESSION_KEY_IDS" >/dev/null 2>&1; then
  die "Memory suppression key preflight failed; nothing was changed."
fi

minio_preflight="$({
  compose exec -T "$minio_service" sh -ceu '
    bucket="$1"
    : "${MINIO_ROOT_USER:?}"
    : "${MINIO_ROOT_PASSWORD:?}"
    mc alias set --quiet restore-target http://127.0.0.1:9000 \
      "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 || exit 20
    mc admin info restore-target >/dev/null 2>&1 || exit 21
    if mc stat "restore-target/$bucket" >/dev/null 2>&1; then
      listing="$(mktemp)"
      trap "rm -f \"$listing\"" EXIT
      mc ls --recursive --json "restore-target/$bucket" >"$listing" 2>/dev/null || exit 22
      if [ -s "$listing" ]; then
        printf nonempty
      else
        printf empty
      fi
    else
      printf missing
    fi
  ' sh "$target_bucket"
} 2>/dev/null)" || die "Could not inspect the disposable MinIO target."
[[ "$minio_preflight" == "empty" || "$minio_preflight" == "missing" ]] || die "Disposable MinIO target bucket is not empty; nothing was changed."

restore_staging="$(mktemp -d /tmp/aiqsa-restore.XXXXXX)"
chmod 700 "$restore_staging"
mkdir -m 700 "$restore_staging/objects"

cleanup() {
  local status=$?
  trap - EXIT
  if ! rm -rf -- "$restore_staging"; then
    info "Error: private restore staging could not be removed."
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if ! tar -C "$restore_staging/objects" --no-same-owner --no-same-permissions \
  -xf "$bundle/objects.tar" >/dev/null 2>&1; then
  die "Private object archive could not be staged safely; no target was changed."
fi
if find "$restore_staging/objects" ! -type d ! -type f -print -quit | grep -q .; then
  die "Private object archive contains an unsupported entry type; no target was changed."
fi

info "Restoring PostgreSQL into the disposable target..."
if ! compose exec -T "$postgres_service" sh -ceu '
  : "${POSTGRES_DB:?}"
  : "${POSTGRES_USER:?}"
  : "${POSTGRES_PASSWORD:?}"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
' <"$bundle/postgres.dump" >/dev/null 2>&1; then
  die "PostgreSQL restore failed. The disposable target is incomplete and was left intact for diagnosis."
fi

restored_schema="$(postgres_query "$(current_schema_query)" 2>/dev/null)" ||
  die "Restore completed but the database schema could not be verified."
restored_schema="${restored_schema//[[:space:]]/}"
[[ "$restored_schema" == "$AIQSA_BACKUP_SCHEMA" ]] ||
  die "Restore completed but the database does not contain the current schema."

restored_memory_key_ids="$(postgres_query '
  SELECT COALESCE(
    string_agg(DISTINCT "fingerprintKeyVersion", '"'"','"'"' ORDER BY "fingerprintKeyVersion"),
    '"'"''"'"'
  )
  FROM "MemorySuppression";
' 2>/dev/null)" || die "Restore completed but Memory suppression key metadata could not be read."
restored_memory_key_ids="${restored_memory_key_ids//$'\r'/}"
restored_memory_key_ids="${restored_memory_key_ids//$'\n'/}"
valid_memory_key_ids "$restored_memory_key_ids" || die "Restore completed with invalid Memory suppression key metadata."
[[ "$restored_memory_key_ids" == "$BACKUP_MEMORY_SUPPRESSION_KEY_IDS" ]] ||
  die "Restore completed but Memory suppression key metadata does not match the bundle manifest."
if ! compose run --rm --no-deps --env HOME=/tmp --entrypoint npm "$tools_service" \
  run memory:suppression:preflight -- restore \
  "$restored_memory_key_ids" >/dev/null 2>&1; then
  die "Restore completed but required Memory suppression keys are unavailable; automatic Memory resume is blocked."
fi

info "Restoring private objects into the disposable target..."
if ! compose run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --volume "$restore_staging/objects:/restore:ro" \
  --entrypoint /bin/sh \
  "$minio_service" -ceu '
  umask 077
  service="$1"
  bucket="$2"
  : "${MINIO_ROOT_USER:?}"
  : "${MINIO_ROOT_PASSWORD:?}"
  mc alias set --quiet restore-target "http://$service:9000" \
    "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 || exit 20
  mc admin info restore-target >/dev/null 2>&1 || exit 21
  if ! mc stat "restore-target/$bucket" >/dev/null 2>&1; then
    mc mb --quiet "restore-target/$bucket" >/dev/null 2>&1 || exit 22
  fi
  mc mirror --quiet --overwrite /restore "restore-target/$bucket" \
    >/dev/null 2>&1 || exit 23
' sh "$minio_service" "$target_bucket" >/dev/null 2>&1; then
  die "Object restore failed. The disposable target is incomplete and was left intact for diagnosis."
fi

restored_relation_count="$(postgres_query "
  SELECT count(*)
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
" 2>/dev/null)" || die "Restore completed but the PostgreSQL post-check failed."
restored_relation_count="${restored_relation_count//[[:space:]]/}"
[[ "$restored_relation_count" =~ ^[0-9]+$ && "$restored_relation_count" -gt 0 ]] || die "Restore completed but the PostgreSQL post-check found no application relations."

assert_isolated_restore_project "$postgres_service" "$minio_service" "$tools_service"

restored_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bundle_sha="$(sha256sum "$bundle/SHA256SUMS" | awk '{ print $1 }')"
compose_config_sha="$(compose config 2>/dev/null | sha256sum | awk '{ print $1 }')" ||
  die "Restore completed but the isolated Compose identity could not be recorded."
review_manifest="$review_directory/review.env"
cat >"$review_manifest" <<REVIEW
AIQSA_RESTORE_REVIEW_FORMAT=1
REVIEW_STATE=PENDING
BACKUP_BUNDLE_SHA256=$bundle_sha
BACKUP_CREATED_AT_UTC=$BACKUP_CREATED_AT_UTC
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
COMPOSE_CONFIG_SHA256=$compose_config_sha
POSTGRES_SERVICE=$postgres_service
MINIO_SERVICE=$minio_service
TOOLS_SERVICE=$tools_service
TARGET_BUCKET=$target_bucket
MEMORY_SUPPRESSION_KEY_IDS=$restored_memory_key_ids
RESTORED_AT_UTC=$restored_at
REVIEW
chmod 600 "$review_manifest"
(
  cd "$review_directory"
  sha256sum review.env >SHA256SUMS
)
chmod 600 "$review_directory/SHA256SUMS"
validate_restore_review_state "$review_directory"

info "Disposable restore completed in quarantine. No application was started and no source data or Docker volume was deleted."
info "Reapply any external post-backup deletion journal, then run ops/backup/review.sh with an explicit journal disposition."
