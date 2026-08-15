#!/usr/bin/env bash

set -Eeuo pipefail

AIQSA_BACKUP_FORMAT="2"

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

backup_migration_inventory() {
  local common_directory repository_root migrations_root migration

  common_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  repository_root="$(cd -- "$common_directory/../.." && pwd -P)"
  migrations_root="$repository_root/prisma/migrations"
  [[ -d "$migrations_root" ]] || die "Committed migration directory is unavailable."

  mapfile -t AIQSA_BACKUP_MIGRATIONS < <(
    find "$migrations_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
      LC_ALL=C sort
  )
  ((${#AIQSA_BACKUP_MIGRATIONS[@]} > 0)) || die "Committed migration history is empty."
  for migration in "${AIQSA_BACKUP_MIGRATIONS[@]}"; do
    [[ "$migration" =~ ^[0-9]{14}_[A-Za-z0-9][A-Za-z0-9_-]*$ ]] ||
      die "Committed migration name is invalid."
    [[ -f "$migrations_root/$migration/migration.sql" ]] ||
      die "Committed migration is incomplete."
  done

  AIQSA_BACKUP_SCHEMA="${AIQSA_BACKUP_MIGRATIONS[${#AIQSA_BACKUP_MIGRATIONS[@]} - 1]}"
}

declare -a AIQSA_BACKUP_MIGRATIONS=()
AIQSA_BACKUP_SCHEMA=""
backup_migration_inventory

info() {
  printf '%s\n' "$1" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

compose() {
  docker compose "$@"
}

service_is_running() {
  local service="$1"

  compose ps --services --status running "$service" 2>/dev/null | grep -Fxq "$service"
}

valid_service_name() {
  [[ "${#1}" -le 64 && "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
}

valid_restore_project_name() {
  [[ "$1" =~ ^aiqsa-restore-[a-z0-9][a-z0-9_-]{0,47}$ ]]
}

valid_bucket_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]
}

compose_has_service() {
  local service="$1"

  compose --profile restore-tools config --services 2>/dev/null | grep -Fxq "$service"
}

assert_isolated_restore_project() {
  local postgres_service="$1"
  local minio_service="$2"
  local tools_service="$3"
  local running service

  valid_restore_project_name "${COMPOSE_PROJECT_NAME:-}" ||
    die "Set a unique COMPOSE_PROJECT_NAME beginning with aiqsa-restore-."
  for service in "$postgres_service" "$minio_service" "$tools_service"; do
    compose_has_service "$service" || die "The isolated restore Compose file is missing a required service."
  done
  running="$(compose ps --services --status running 2>/dev/null)" ||
    die "Could not inspect the isolated restore project."
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    if [[ "$service" != "$postgres_service" && "$service" != "$minio_service" ]]; then
      die "The isolated restore project contains a running service outside the database/object allowlist."
    fi
  done <<<"$running"
}

valid_memory_key_ids() {
  local value="$1"
  local previous=""
  local key_id
  local -a key_ids=()

  [[ "${#value}" -le 32768 ]] || return 1
  [[ -n "$value" ]] || return 0
  IFS=',' read -r -a key_ids <<<"$value"
  [[ "${#key_ids[@]}" -le 256 ]] || return 1
  for key_id in "${key_ids[@]}"; do
    [[ "$key_id" =~ ^[a-z][a-z0-9_-]{0,63}$ && "$key_id" != "current" ]] || return 1
    [[ -z "$previous" || "$key_id" > "$previous" ]] || return 1
    previous="$key_id"
  done
}

current_schema_query() {
  local expected_migrations="" migration

  for migration in "${AIQSA_BACKUP_MIGRATIONS[@]}"; do
    expected_migrations+="'$migration',"
  done
  expected_migrations="${expected_migrations%,}"

  cat <<SQL
SELECT CASE
  WHEN (SELECT count(*) FROM "_prisma_migrations") = ${#AIQSA_BACKUP_MIGRATIONS[@]}
    AND ARRAY(
      SELECT migration_name::text
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at, id
    )
      = ARRAY[$expected_migrations]::text[]
    AND to_regclass('public."UserMemorySettings"') IS NOT NULL
    AND to_regclass('public."MemorySuppression"') IS NOT NULL
    AND to_regclass('public."MemorySourceBarrier"') IS NOT NULL
    AND to_regclass('public."MemoryDeletionOutbox"') IS NOT NULL
    AND to_regclass('public."MemoryJob"') IS NOT NULL
    AND to_regclass('public."MemoryExecutionBinding"') IS NOT NULL
  THEN '$AIQSA_BACKUP_SCHEMA'
  ELSE 'incompatible'
END;
SQL
}

validate_current_schema_archive_listing() {
  local listing="$1"
  local required
  local -a required_relations=(
    _prisma_migrations
    UserMemorySettings
    MemorySuppression
    MemorySourceBarrier
    MemoryDeletionOutbox
    MemoryJob
    MemoryExecutionBinding
  )

  for required in "${required_relations[@]}"; do
    awk -v required="$required" '
      index($0, " TABLE public ") {
        name = $(NF - 1)
        gsub(/^"|"$/, "", name)
        if (name == required) {
          found = 1
        }
      }
      END { exit found ? 0 : 1 }
    ' <<<"$listing" || return 1
  done
}

manifest_value() {
  local manifest="$1"
  local key="$2"

  awk -F= -v wanted="$key" '
    $1 == wanted {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END {
      if (count != 1) {
        exit 1
      }
      print value
    }
  ' "$manifest"
}

validate_checksum_manifest() {
  local checksum_file="$1"

  awk '
    NF != 2 || $1 !~ /^[0-9a-f]{64}$/ { exit 1 }
    $2 == "manifest.env" { manifest += 1; next }
    $2 == "postgres.dump" { postgres += 1; next }
    $2 == "objects.tar" { objects += 1; next }
    { exit 1 }
    END {
      if (NR != 3 || manifest != 1 || postgres != 1 || objects != 1) {
        exit 1
      }
    }
  ' "$checksum_file"
}

validate_bundle() {
  local bundle="$1"
  local format schema created_at app_revision postgres_version dump_format archive_format memory_key_ids

  [[ -d "$bundle" && ! -L "$bundle" ]] || die "Backup bundle must be a real directory, not a symlink."

  local filename
  for filename in manifest.env postgres.dump objects.tar SHA256SUMS; do
    [[ -f "$bundle/$filename" && ! -L "$bundle/$filename" ]] || die "Backup bundle is missing a required regular file."
  done

  validate_checksum_manifest "$bundle/SHA256SUMS" || die "Backup checksum manifest is invalid."
  (
    cd "$bundle"
    sha256sum --check --strict SHA256SUMS >/dev/null 2>&1
  ) || die "Backup checksum verification failed."

  format="$(manifest_value "$bundle/manifest.env" AIQSA_BACKUP_FORMAT)" || die "Backup version manifest is invalid."
  schema="$(manifest_value "$bundle/manifest.env" AIQSA_BACKUP_SCHEMA)" || die "Backup schema manifest is invalid."
  created_at="$(manifest_value "$bundle/manifest.env" CREATED_AT_UTC)" || die "Backup version manifest is invalid."
  app_revision="$(manifest_value "$bundle/manifest.env" APP_REVISION)" || die "Backup version manifest is invalid."
  postgres_version="$(manifest_value "$bundle/manifest.env" POSTGRES_SERVER_VERSION_NUM)" || die "Backup version manifest is invalid."
  dump_format="$(manifest_value "$bundle/manifest.env" POSTGRES_DUMP_FORMAT)" || die "Backup version manifest is invalid."
  archive_format="$(manifest_value "$bundle/manifest.env" OBJECT_ARCHIVE_FORMAT)" || die "Backup version manifest is invalid."

  [[ "$format" == "$AIQSA_BACKUP_FORMAT" ]] || die "Backup format is incompatible with this restore tool."
  [[ "$schema" == "$AIQSA_BACKUP_SCHEMA" ]] || die "Backup schema is incompatible with this restore tool."
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "Backup timestamp is invalid."
  [[ "$app_revision" =~ ^([0-9a-f]{40}|unknown)$ ]] || die "Backup application revision is invalid."
  [[ "$postgres_version" =~ ^[0-9]{5,6}$ ]] || die "Backup PostgreSQL version is invalid."
  [[ "$dump_format" == "custom" ]] || die "Backup PostgreSQL dump format is incompatible."
  [[ "$archive_format" == "tar" ]] || die "Backup object archive format is incompatible."
  [[ "$(LC_ALL=C head -c 5 "$bundle/postgres.dump")" == "PGDMP" ]] || die "Backup PostgreSQL dump header is invalid."
  tar -tf "$bundle/objects.tar" >/dev/null 2>&1 || die "Backup object archive is invalid."

  memory_key_ids="$(manifest_value "$bundle/manifest.env" MEMORY_SUPPRESSION_KEY_IDS)" || die "Backup Memory key metadata is invalid."
  valid_memory_key_ids "$memory_key_ids" || die "Backup Memory key metadata is invalid."

  BACKUP_CREATED_AT_UTC="$created_at"
  BACKUP_MEMORY_SUPPRESSION_KEY_IDS="$memory_key_ids"
  BACKUP_POSTGRES_VERSION_NUM="$postgres_version"
}

validate_restore_review_state() {
  local directory="$1"
  local format state bundle_sha created_at project compose_config_sha postgres_service minio_service
  local tools_service bucket memory_key_ids restored_at checksum_line

  [[ -d "$directory" && ! -L "$directory" ]] ||
    die "Restore review state must be a real directory, not a symlink."
  for filename in review.env SHA256SUMS; do
    [[ -f "$directory/$filename" && ! -L "$directory/$filename" ]] ||
      die "Restore review state is incomplete."
  done
  checksum_line="$(awk '
    NF == 2 && $1 ~ /^[0-9a-f]{64}$/ && $2 == "review.env" { count += 1 }
    END { if (NR != 1 || count != 1) exit 1; print $0 }
  ' "$directory/SHA256SUMS")" || die "Restore review checksum manifest is invalid."
  [[ -n "$checksum_line" ]] || die "Restore review checksum manifest is invalid."
  (
    cd "$directory"
    sha256sum --check --strict SHA256SUMS >/dev/null 2>&1
  ) || die "Restore review checksum verification failed."

  format="$(manifest_value "$directory/review.env" AIQSA_RESTORE_REVIEW_FORMAT)" ||
    die "Restore review manifest is invalid."
  state="$(manifest_value "$directory/review.env" REVIEW_STATE)" ||
    die "Restore review manifest is invalid."
  bundle_sha="$(manifest_value "$directory/review.env" BACKUP_BUNDLE_SHA256)" ||
    die "Restore review manifest is invalid."
  created_at="$(manifest_value "$directory/review.env" BACKUP_CREATED_AT_UTC)" ||
    die "Restore review manifest is invalid."
  project="$(manifest_value "$directory/review.env" COMPOSE_PROJECT_NAME)" ||
    die "Restore review manifest is invalid."
  compose_config_sha="$(manifest_value "$directory/review.env" COMPOSE_CONFIG_SHA256)" ||
    die "Restore review manifest is invalid."
  postgres_service="$(manifest_value "$directory/review.env" POSTGRES_SERVICE)" ||
    die "Restore review manifest is invalid."
  minio_service="$(manifest_value "$directory/review.env" MINIO_SERVICE)" ||
    die "Restore review manifest is invalid."
  tools_service="$(manifest_value "$directory/review.env" TOOLS_SERVICE)" ||
    die "Restore review manifest is invalid."
  bucket="$(manifest_value "$directory/review.env" TARGET_BUCKET)" ||
    die "Restore review manifest is invalid."
  memory_key_ids="$(manifest_value "$directory/review.env" MEMORY_SUPPRESSION_KEY_IDS)" ||
    die "Restore review manifest is invalid."
  restored_at="$(manifest_value "$directory/review.env" RESTORED_AT_UTC)" ||
    die "Restore review manifest is invalid."

  [[ "$format" == "1" && "$state" == "PENDING" ]] || die "Restore review manifest is incompatible."
  [[ "$bundle_sha" =~ ^[0-9a-f]{64}$ ]] || die "Restore review bundle identity is invalid."
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die "Restore review backup timestamp is invalid."
  [[ "$restored_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die "Restore review timestamp is invalid."
  valid_restore_project_name "$project" || die "Restore review project identity is invalid."
  [[ "$compose_config_sha" =~ ^[0-9a-f]{64}$ ]] || die "Restore review Compose identity is invalid."
  valid_service_name "$postgres_service" || die "Restore review PostgreSQL service is invalid."
  valid_service_name "$minio_service" || die "Restore review MinIO service is invalid."
  valid_service_name "$tools_service" || die "Restore review tools service is invalid."
  [[ "$postgres_service" != "$minio_service" && "$postgres_service" != "$tools_service" &&
    "$minio_service" != "$tools_service" ]] || die "Restore review service identities conflict."
  valid_bucket_name "$bucket" || die "Restore review bucket is invalid."
  valid_memory_key_ids "$memory_key_ids" || die "Restore review Memory key metadata is invalid."

  RESTORE_REVIEW_BUNDLE_SHA256="$bundle_sha"
  RESTORE_REVIEW_BACKUP_CREATED_AT_UTC="$created_at"
  RESTORE_REVIEW_PROJECT="$project"
  RESTORE_REVIEW_COMPOSE_CONFIG_SHA256="$compose_config_sha"
  RESTORE_REVIEW_POSTGRES_SERVICE="$postgres_service"
  RESTORE_REVIEW_MINIO_SERVICE="$minio_service"
  RESTORE_REVIEW_TOOLS_SERVICE="$tools_service"
  RESTORE_REVIEW_BUCKET="$bucket"
  RESTORE_REVIEW_MEMORY_KEY_IDS="$memory_key_ids"
  RESTORE_REVIEW_RESTORED_AT_UTC="$restored_at"
}
