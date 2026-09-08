#!/bin/sh
set -eu

if [ -e .env ] || [ -L .env ]; then
  printf '%s\n' '.env already exists; its configuration and secrets were preserved.' >&2
  exit 1
fi
if [ ! -f .env.example ] || [ ! -f compose.yaml ]; then
  printf '%s\n' 'Run this command from the AIQSA repository directory.' >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  printf '%s\n' 'OpenSSL is required to generate installation secrets.' >&2
  exit 1
}

umask 077
configuration_tmp=$(mktemp .env.tmp.XXXXXX)
trap 'rm -f "$configuration_tmp"' 0
trap 'exit 1' 1 2 3 15

while IFS= read -r configuration_line || [ -n "$configuration_line" ]; do
  case "$configuration_line" in
    AIQSA_INITIAL_ADMIN_PASSWORD=|AIQSA_AUTH_SESSION_SECRET=|AIQSA_POSTGRES_PASSWORD=|AIQSA_S3_SECRET_ACCESS_KEY=)
      configuration_secret=$(openssl rand -hex 32)
      printf '%s%s\n' "$configuration_line" "$configuration_secret"
      ;;
    AIQSA_ENCRYPTION_KEY=|AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY=)
      configuration_secret=$(openssl rand -base64 32)
      printf '%s%s\n' "$configuration_line" "$configuration_secret"
      ;;
    AIQSA_MEMORY_FINGERPRINT_KEYRING=)
      configuration_secret=$(openssl rand -base64 32)
      printf '%scurrent=v1,v1=%s\n' "$configuration_line" "$configuration_secret"
      ;;
    *) printf '%s\n' "$configuration_line" ;;
  esac
done < .env.example > "$configuration_tmp"

# Hard-link publication is atomic and never replaces an existing file/symlink.
ln "$configuration_tmp" .env
printf '%s\n' '.env created with private permissions and unique secrets.' \
  'Set AIQSA_INITIAL_ADMIN_EMAIL and AIQSA_APP_BASE_URL in .env, then run docker compose up -d.'
