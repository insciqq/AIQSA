#!/usr/bin/env bash

set -euo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="${SCRIPT_DIR}/.env"
ADMIN_EMAIL=""
TEMPLATE_FILE="${SCRIPT_DIR}/.env.example"
STAGING_FILE=""
REWRITE_FILE=""

usage() {
  cat <<'EOF'
Usage: bash prepare-secrets.sh [--admin-email EMAIL] [--env-file PATH]

Create a first-install .env and fill its required secrets. If the target file
already exists, exit successfully without reading or changing it.

Options:
  --admin-email EMAIL  Set the initial administrator email without a prompt.
  --env-file PATH      Prepare another env file instead of the repository .env.
  -h, --help           Show this help.
EOF
}

fail() {
  printf 'prepare-secrets: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${REWRITE_FILE}" && -e "${REWRITE_FILE}" ]]; then
    rm -f -- "${REWRITE_FILE}"
  fi
  if [[ -n "${STAGING_FILE}" && -e "${STAGING_FILE}" ]]; then
    rm -f -- "${STAGING_FILE}"
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while (( $# > 0 )); do
  case "$1" in
    --admin-email)
      (( $# >= 2 )) || fail "--admin-email requires a value"
      ADMIN_EMAIL="$2"
      shift 2
      ;;
    --admin-email=*)
      ADMIN_EMAIL="${1#*=}"
      shift
      ;;
    --env-file)
      (( $# >= 2 )) || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "${ENV_FILE}" ]] || fail "--env-file must not be empty"
if [[ -e "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
  printf '%s already exists; nothing was read or changed.\n' "${ENV_FILE}"
  exit 0
fi

for required_command in openssl mktemp cp chmod mv ln rm; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "required command is unavailable: ${required_command}"
done

[[ -f "${TEMPLATE_FILE}" ]] || fail "missing template: ${TEMPLATE_FILE}"

env_parent="$(dirname -- "${ENV_FILE}")"
[[ -d "${env_parent}" ]] || fail "environment directory does not exist: ${env_parent}"
env_parent="$(cd -- "${env_parent}" && pwd -P)"
FINAL_ENV_FILE="${env_parent}/$(basename -- "${ENV_FILE}")"

if [[ -e "${FINAL_ENV_FILE}" || -L "${FINAL_ENV_FILE}" ]]; then
  printf '%s already exists; nothing was read or changed.\n' "${FINAL_ENV_FILE}"
  exit 0
fi

STAGING_FILE="$(mktemp "${env_parent}/.$(basename -- "${FINAL_ENV_FILE}").prepare.XXXXXX")"
cp -- "${TEMPLATE_FILE}" "${STAGING_FILE}"
chmod 600 -- "${STAGING_FILE}"
ENV_FILE="${STAGING_FILE}"

LOOKUP_FOUND=0
LOOKUP_VALUE=""

lookup_env_value() {
  local key="$1"
  local line
  local matches=0

  LOOKUP_FOUND=0
  LOOKUP_VALUE=""

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    if [[ "${line}" == "${key}="* ]]; then
      matches=$((matches + 1))
      LOOKUP_FOUND=1
      LOOKUP_VALUE="${line#*=}"
    fi
  done < "${ENV_FILE}"

  (( matches <= 1 )) || fail "duplicate ${key} entries in ${ENV_FILE}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local line
  local found=0

  REWRITE_FILE="$(mktemp "${env_parent}/.$(basename -- "${FINAL_ENV_FILE}").tmp.XXXXXX")"
  chmod 600 -- "${REWRITE_FILE}"

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    if [[ "${line}" == "${key}="* ]]; then
      printf '%s=%s\n' "${key}" "${value}" >> "${REWRITE_FILE}"
      found=1
    else
      printf '%s\n' "${line}" >> "${REWRITE_FILE}"
    fi
  done < "${ENV_FILE}"

  if (( found == 0 )); then
    printf '\n%s=%s\n' "${key}" "${value}" >> "${REWRITE_FILE}"
  fi

  mv -f -- "${REWRITE_FILE}" "${ENV_FILE}"
  REWRITE_FILE=""
  chmod 600 -- "${ENV_FILE}"
}

value_needs_generation() {
  local key="$1"
  local placeholder="$2"

  lookup_env_value "${key}"
  [[ "${LOOKUP_FOUND}" == "0" \
    || -z "${LOOKUP_VALUE}" \
    || "${LOOKUP_VALUE}" == '""' \
    || "${LOOKUP_VALUE}" == "''" \
    || "${LOOKUP_VALUE}" == "${placeholder}" ]]
}

valid_admin_email() {
  local candidate="$1"

  (( ${#candidate} <= 320 )) \
    && [[ "${candidate}" =~ ^[A-Za-z0-9.!%+_-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$ ]]
}

lookup_env_value "AIQSA_INITIAL_ADMIN_EMAIL"
current_admin_email="${LOOKUP_VALUE}"
email_needs_preparation=0
if [[ "${LOOKUP_FOUND}" == "0" \
  || -z "${current_admin_email}" \
  || "${current_admin_email}" == '""' \
  || "${current_admin_email}" == "''" \
  || "${current_admin_email}" == "replace-with-admin-email" ]]; then
  email_needs_preparation=1
fi

if (( email_needs_preparation == 1 )); then
  if [[ -z "${ADMIN_EMAIL}" ]]; then
    [[ -t 0 ]] \
      || fail "initial administrator email is unset; rerun with --admin-email EMAIL"
    while true; do
      read -r -p "Initial administrator email: " ADMIN_EMAIL
      if valid_admin_email "${ADMIN_EMAIL}"; then
        break
      fi
      printf 'Enter a plain email address such as admin@example.com.\n' >&2
    done
  fi
  valid_admin_email "${ADMIN_EMAIL}" \
    || fail "--admin-email must be a plain valid email address"
  set_env_value "AIQSA_INITIAL_ADMIN_EMAIL" "${ADMIN_EMAIL}"
  current_admin_email="${ADMIN_EMAIL}"
elif [[ -n "${ADMIN_EMAIL}" && "${ADMIN_EMAIL}" != "${current_admin_email}" ]]; then
  fail "AIQSA_INITIAL_ADMIN_EMAIL is already set; refusing to replace the bootstrap identity"
elif ! valid_admin_email "${current_admin_email}"; then
  fail "existing AIQSA_INITIAL_ADMIN_EMAIL is not a plain valid email address"
fi

generated_keys=()

ensure_hex_secret() {
  local key="$1"
  local placeholder="$2"
  local byte_count="$3"

  if value_needs_generation "${key}" "${placeholder}"; then
    set_env_value "${key}" "$(openssl rand -hex "${byte_count}")"
    generated_keys+=("${key}")
  fi
}

ensure_base64_secret() {
  local key="$1"
  local placeholder="$2"
  local byte_count="$3"

  if value_needs_generation "${key}" "${placeholder}"; then
    set_env_value "${key}" "$(openssl rand -base64 "${byte_count}")"
    generated_keys+=("${key}")
  fi
}

ensure_memory_fingerprint_keyring() {
  local key="AIQSA_MEMORY_FINGERPRINT_KEYRING"
  local placeholder="current=v1,v1=replace-with-base64-encoded-32-byte-key"

  if value_needs_generation "${key}" "${placeholder}"; then
    set_env_value "${key}" "current=v1,v1=$(openssl rand -base64 32)"
    generated_keys+=("${key}")
  fi
}

ensure_hex_secret "AIQSA_AUTH_SESSION_SECRET" "replace-with-random-session-secret" 32
ensure_base64_secret "AIQSA_ENCRYPTION_KEY" "replace-with-base64-encoded-32-byte-key" 32
ensure_memory_fingerprint_keyring
ensure_hex_secret "AIQSA_POSTGRES_PASSWORD" "replace-with-random-postgres-password" 32
ensure_hex_secret "AIQSA_S3_SECRET_ACCESS_KEY" "replace-with-random-object-storage-secret" 32

generated_admin_password=""
if value_needs_generation "AIQSA_INITIAL_ADMIN_PASSWORD" "replace-with-admin-password"; then
  generated_admin_password="$(openssl rand -hex 18)"
  set_env_value "AIQSA_INITIAL_ADMIN_PASSWORD" "${generated_admin_password}"
  generated_keys+=("AIQSA_INITIAL_ADMIN_PASSWORD")
fi

ln -- "${STAGING_FILE}" "${FINAL_ENV_FILE}" 2>/dev/null \
  || fail "${FINAL_ENV_FILE} appeared while secrets were being prepared; it was left unchanged"
rm -f -- "${STAGING_FILE}"
STAGING_FILE=""
ENV_FILE="${FINAL_ENV_FILE}"

printf 'Created %s from %s with mode 0600.\n' "${ENV_FILE}" "${TEMPLATE_FILE}"

if (( ${#generated_keys[@]} > 0 )); then
  printf 'Generated missing values for:\n'
  for generated_key in "${generated_keys[@]}"; do
    printf '  - %s\n' "${generated_key}"
  done
else
  printf 'The template already contained all required values.\n'
fi

if [[ -n "${generated_admin_password}" ]]; then
  printf '\nInitial administrator credentials:\n'
  printf '  Email: %s\n' "${current_admin_email}"
  printf '  Password: %s\n' "${generated_admin_password}"
  printf 'The password is shown once and is also stored in %s.\n' "${ENV_FILE}"
else
  printf 'The existing initial administrator password was preserved and not displayed.\n'
fi

printf '\nKeep this file private and back up AIQSA_ENCRYPTION_KEY and AIQSA_MEMORY_FINGERPRINT_KEYRING separately.\n'
if [[ "${ENV_FILE}" == "${SCRIPT_DIR}/.env" ]]; then
  printf 'Next: docker compose pull && docker compose up -d\n'
else
  printf 'Use this file explicitly with Docker Compose: --env-file %s\n' "${ENV_FILE}"
fi
