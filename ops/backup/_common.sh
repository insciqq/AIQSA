#!/usr/bin/env bash

set -Eeuo pipefail

AIQSA_BACKUP_FORMAT="2"

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

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
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
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
  local format created_at app_revision postgres_version dump_format archive_format memory_key_ids

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
  created_at="$(manifest_value "$bundle/manifest.env" CREATED_AT_UTC)" || die "Backup version manifest is invalid."
  app_revision="$(manifest_value "$bundle/manifest.env" APP_REVISION)" || die "Backup version manifest is invalid."
  postgres_version="$(manifest_value "$bundle/manifest.env" POSTGRES_SERVER_VERSION_NUM)" || die "Backup version manifest is invalid."
  dump_format="$(manifest_value "$bundle/manifest.env" POSTGRES_DUMP_FORMAT)" || die "Backup version manifest is invalid."
  archive_format="$(manifest_value "$bundle/manifest.env" OBJECT_ARCHIVE_FORMAT)" || die "Backup version manifest is invalid."

  [[ "$format" == "1" || "$format" == "$AIQSA_BACKUP_FORMAT" ]] || die "Backup format is incompatible with this restore tool."
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "Backup timestamp is invalid."
  [[ "$app_revision" =~ ^([0-9a-f]{40}|unknown)$ ]] || die "Backup application revision is invalid."
  [[ "$postgres_version" =~ ^[0-9]{5,6}$ ]] || die "Backup PostgreSQL version is invalid."
  [[ "$dump_format" == "custom" ]] || die "Backup PostgreSQL dump format is incompatible."
  [[ "$archive_format" == "tar" ]] || die "Backup object archive format is incompatible."
  [[ "$(LC_ALL=C head -c 5 "$bundle/postgres.dump")" == "PGDMP" ]] || die "Backup PostgreSQL dump header is invalid."
  tar -tf "$bundle/objects.tar" >/dev/null 2>&1 || die "Backup object archive is invalid."

  memory_key_ids=""
  if [[ "$format" == "2" ]]; then
    memory_key_ids="$(manifest_value "$bundle/manifest.env" MEMORY_SUPPRESSION_KEY_IDS)" || die "Backup Memory key metadata is invalid."
    valid_memory_key_ids "$memory_key_ids" || die "Backup Memory key metadata is invalid."
  fi

  BACKUP_FORMAT="$format"
  BACKUP_MEMORY_SUPPRESSION_KEY_IDS="$memory_key_ids"
  BACKUP_POSTGRES_VERSION_NUM="$postgres_version"
}
