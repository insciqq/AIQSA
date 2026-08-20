#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_unit="$REPOSITORY_ROOT/ops/systemd/aiqsa-backup.service.template"
prune_unit="$REPOSITORY_ROOT/ops/systemd/aiqsa-prune.service.template"

fail() {
  printf 'Maintenance lock test failed: %s\n' "$1" >&2
  exit 1
}

backup_exec="$(sed -n 's/^ExecStart=//p' "$backup_unit")"
prune_exec="$(sed -n 's/^ExecStart=//p' "$prune_unit")"
[[ "$backup_exec" == \
  '/usr/bin/flock --wait 300 __AIQSA_OPERATION_LOCK__ __AIQSA_CURRENT_DIRECTORY__/ops/backup/create.sh __AIQSA_BACKUP_DIRECTORY__' ]] ||
  fail "backup unit does not acquire the shared operation lock before create.sh"
[[ "$prune_exec" == \
  '/usr/bin/flock --wait 300 __AIQSA_OPERATION_LOCK__ /usr/bin/docker compose run --rm -T app npm run prune -- --execute' ]] ||
  fail "prune unit does not acquire the shared operation lock before deletion"
[[ "$(grep -c '^ExecStart=' "$backup_unit")" -eq 1 ]] ||
  fail "backup unit contains an ambiguous ExecStart"
[[ "$(grep -c '__AIQSA_OPERATION_LOCK__' "$backup_unit")" -eq 1 ]] ||
  fail "backup unit operation-lock placeholder is missing or duplicated"

printf 'Maintenance lock test passed.\n'
