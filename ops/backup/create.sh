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

Create a coordinated AIQSA backup while app is stopped. The script restarts
app only when it was running before the backup began. This assumes app is the
only writer to its PostgreSQL database and bucket.

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

if service_is_running app; then
  app_was_running=1
  info "Stopping app for a write-quiesced backup..."
  compose stop app >/dev/null
fi

if service_is_running app; then
  die "app is still running; backup was not started."
fi

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
