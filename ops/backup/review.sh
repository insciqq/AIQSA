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
  ops/backup/review.sh --deletion-journal-not-required REVIEW_DIRECTORY
  ops/backup/review.sh --deletion-journal-applied JOURNAL_FILE REVIEW_DIRECTORY

Run this only after restore.sh has populated an isolated aiqsa-restore-* project.
If an external deletion journal covers the interval after the backup timestamp,
apply it through its owning operator procedure before selecting --applied. This
command never interprets or stores journal contents; it records only their
SHA-256 evidence identity. --not-required is an explicit operator attestation
that no external post-backup journal entries exist for that interval.

The command keeps all application/provider roles absent, rechecks suppression
keys, drives only the deletion coordinator in the network-isolated tools role,
audits outbox/account/source-barrier state, and writes a private promotion.env
receipt. It never starts an app/worker or performs production cutover.
USAGE
}

journal_status=""
journal_sha=""
review_directory=""
case "${1:-}" in
  --deletion-journal-not-required)
    [[ "$#" -eq 2 ]] || {
      usage >&2
      exit 2
    }
    journal_status="NOT_REQUIRED"
    journal_sha="none"
    review_directory="$2"
    ;;
  --deletion-journal-applied)
    [[ "$#" -eq 3 ]] || {
      usage >&2
      exit 2
    }
    [[ -f "$2" && ! -L "$2" ]] ||
      die "External deletion journal evidence must be a regular file, not a symlink."
    require_command sha256sum
    journal_status="APPLIED"
    journal_sha="$(sha256sum "$2" | awk '{ print $1 }')"
    [[ "$journal_sha" =~ ^[0-9a-f]{64}$ ]] ||
      die "External deletion journal evidence could not be identified."
    review_directory="$3"
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

[[ "${AIQSA_RESTORE_DISPOSABLE_TARGET:-}" == "YES" ]] ||
  die "Set AIQSA_RESTORE_DISPOSABLE_TARGET=YES for an explicitly disposable review target."

require_command docker
require_command sha256sum
cd "$REPOSITORY_ROOT"
validate_restore_review_state "$review_directory"
review_directory="$(cd -- "$review_directory" && pwd -P)"

[[ "${COMPOSE_PROJECT_NAME:-}" == "$RESTORE_REVIEW_PROJECT" ]] ||
  die "The active Compose project does not match the restore review state."
current_compose_sha="$(compose config 2>/dev/null | sha256sum | awk '{ print $1 }')" ||
  die "The isolated Compose identity could not be verified."
[[ "$current_compose_sha" == "$RESTORE_REVIEW_COMPOSE_CONFIG_SHA256" ]] ||
  die "The isolated Compose configuration changed after restore."
[[ "${AIQSA_RESTORE_BUCKET:-}" == "$RESTORE_REVIEW_BUCKET" ]] ||
  die "The configured restore bucket does not match the restore review state."

[[ ! -e "$review_directory/promotion.env" &&
  ! -e "$review_directory/PROMOTION_SHA256SUMS" ]] ||
  die "A promotion receipt already exists; it will not be overwritten."

assert_isolated_restore_project \
  "$RESTORE_REVIEW_POSTGRES_SERVICE" \
  "$RESTORE_REVIEW_MINIO_SERVICE" \
  "$RESTORE_REVIEW_TOOLS_SERVICE"
service_is_running "$RESTORE_REVIEW_POSTGRES_SERVICE" ||
  die "Disposable PostgreSQL review service is not running."
service_is_running "$RESTORE_REVIEW_MINIO_SERVICE" ||
  die "Disposable MinIO review service is not running."

postgres_query() {
  local sql="$1"

  compose exec -T "$RESTORE_REVIEW_POSTGRES_SERVICE" sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"
  ' sh "$sql"
}

info "Rechecking Memory suppression keys in quarantine..."
if ! compose run --rm --no-deps --env HOME=/tmp --entrypoint npm \
  "$RESTORE_REVIEW_TOOLS_SERVICE" --silent run memory:suppression:preflight -- \
  restore "$RESTORE_REVIEW_MEMORY_KEY_IDS" >/dev/null 2>&1; then
  die "Restore review blocked: required Memory suppression keys are unavailable."
fi

restored_schema="$(postgres_query "$(current_schema_query)" 2>/dev/null)" ||
  die "Restore review blocked: the database schema could not be inspected."
restored_schema="${restored_schema//[[:space:]]/}"
[[ "$restored_schema" == "$AIQSA_BACKUP_SCHEMA" ]] ||
  die "Restore review blocked: the database does not contain the current schema."

audit_schema="$AIQSA_BACKUP_SCHEMA"
restored_key_ids="$(postgres_query '
  SELECT COALESCE(
    string_agg(DISTINCT "fingerprintKeyVersion", '"'"','"'"' ORDER BY "fingerprintKeyVersion"),
    '"'"''"'"'
  )
  FROM "MemorySuppression";
' 2>/dev/null)" ||
  die "Restore review blocked: Memory suppression metadata could not be read."
restored_key_ids="${restored_key_ids//$'\r'/}"
restored_key_ids="${restored_key_ids//$'\n'/}"
valid_memory_key_ids "$restored_key_ids" ||
  die "Restore review blocked: Memory suppression metadata is invalid."
[[ "$restored_key_ids" == "$RESTORE_REVIEW_MEMORY_KEY_IDS" ]] ||
  die "Restore review blocked: Memory suppression metadata changed after restore."

info "Reconciling deletion obligations without provider/job handlers..."
reconciliation_output=""
if ! reconciliation_output="$(compose run --rm --no-deps --env HOME=/tmp \
  --entrypoint npm "$RESTORE_REVIEW_TOOLS_SERVICE" --silent run \
  memory:restore:reconcile 2>&1)"; then
  reconciliation_code="$(printf '%s\n' "$reconciliation_output" |
    grep -Eo 'memory_[a-z0-9_]+' | tail -n 1 || true)"
  [[ "$reconciliation_code" =~ ^memory_[a-z0-9_]+$ ]] ||
    reconciliation_code="memory_restore_reconciliation_failed"
  die "Restore review blocked: deletion reconciliation remains incomplete ($reconciliation_code)."
fi

audit_values="$(postgres_query "
  SELECT concat_ws(',',
    (SELECT count(*) FROM \"MemoryDeletionOutbox\"
      WHERE \"state\" IN (
        'PENDING'::\"MemoryDeletionState\",
        'RUNNING'::\"MemoryDeletionState\",
        'RETRY_WAIT'::\"MemoryDeletionState\",
        'BLOCKED_REQUIRES_ADMIN'::\"MemoryDeletionState\"
      )),
    (SELECT count(*) FROM \"MemoryDeletionOutbox\"
      WHERE \"operation\" = 'ACCOUNT_MEMORY_DELETE'::\"MemoryDeletionOperation\"),
    (SELECT count(*) FROM \"MemoryDeletionOutbox\"
      WHERE \"leaseToken\" IS NOT NULL OR \"leaseExpiresAt\" IS NOT NULL),
    (SELECT count(*) FROM \"MemoryJob\"
      WHERE \"state\" = 'CLAIMED'::\"MemoryJobState\"
        OR \"leaseToken\" IS NOT NULL OR \"leaseExpiresAt\" IS NOT NULL),
    (SELECT count(*)
      FROM \"MemoryExecutionBinding\"
      WHERE \"state\" IN (
        'RUNNING'::\"MemoryExecutionState\",
        'OUTCOME_UNKNOWN'::\"MemoryExecutionState\"
      )),
    (SELECT count(*)
      FROM \"MemorySourceBarrier\" AS barrier
      LEFT JOIN \"UserMemorySettings\" AS settings
        ON settings.\"userId\" = barrier.\"userId\"
      WHERE settings.\"userId\" IS NULL
        OR barrier.\"memoryGeneration\" > settings.\"memoryGeneration\"),
    (SELECT count(*)
      FROM \"MemorySourceBarrier\" AS barrier
      WHERE NOT EXISTS (
        SELECT 1
        FROM \"MemoryDeletionOutbox\" AS deletion
        WHERE deletion.\"userId\" = barrier.\"userId\"
          AND deletion.\"targetId\" = barrier.\"id\"
          AND deletion.\"state\" <> 'CANCELLED'::\"MemoryDeletionState\"
          AND (
            (barrier.\"kind\" = 'AUTOMATIC_FACTS'::\"MemorySourceBarrierKind\"
              AND deletion.\"operation\" = 'FORGET_PURGE'::\"MemoryDeletionOperation\"
              AND deletion.\"targetType\" LIKE 'AUTOMATIC_SET@%')
            OR (barrier.\"kind\" = 'ALL_REUSABLE'::\"MemorySourceBarrierKind\"
              AND deletion.\"operation\" = 'FORGET_PURGE'::\"MemoryDeletionOperation\"
              AND deletion.\"targetType\" LIKE 'ALL_REUSABLE@%')
            OR (barrier.\"kind\" = 'HISTORY_INDEX'::\"MemorySourceBarrierKind\"
              AND deletion.\"operation\" = 'BULK_CLEAR'::\"MemoryDeletionOperation\"
              AND deletion.\"targetType\" LIKE 'HISTORY_INDEX@%')
          )
      )),
    (SELECT count(*)
      FROM \"MemoryDeletionOutbox\" AS deletion
      WHERE deletion.\"state\" <> 'CANCELLED'::\"MemoryDeletionState\"
        AND (
          (deletion.\"targetType\" LIKE 'AUTOMATIC_SET@%' AND NOT EXISTS (
            SELECT 1 FROM \"MemorySourceBarrier\" AS barrier
            WHERE barrier.\"userId\" = deletion.\"userId\"
              AND barrier.\"id\" = deletion.\"targetId\"
              AND barrier.\"kind\" = 'AUTOMATIC_FACTS'::\"MemorySourceBarrierKind\"))
          OR (deletion.\"targetType\" LIKE 'ALL_REUSABLE@%' AND NOT EXISTS (
            SELECT 1 FROM \"MemorySourceBarrier\" AS barrier
            WHERE barrier.\"userId\" = deletion.\"userId\"
              AND barrier.\"id\" = deletion.\"targetId\"
              AND barrier.\"kind\" = 'ALL_REUSABLE'::\"MemorySourceBarrierKind\"))
          OR (deletion.\"targetType\" LIKE 'HISTORY_INDEX@%' AND NOT EXISTS (
            SELECT 1 FROM \"MemorySourceBarrier\" AS barrier
            WHERE barrier.\"userId\" = deletion.\"userId\"
              AND barrier.\"id\" = deletion.\"targetId\"
              AND barrier.\"kind\" = 'HISTORY_INDEX'::\"MemorySourceBarrierKind\"))
        ))
  );
" 2>/dev/null)" ||
  die "Restore review blocked: deletion/barrier audit failed."
audit_values="${audit_values//[[:space:]]/}"

[[ "$audit_values" =~ ^[0-9]+(,[0-9]+){7}$ ]] ||
  die "Restore review blocked: deletion/barrier audit returned invalid evidence."
IFS=',' read -r unresolved account_obligations deletion_leases job_leases \
  unsafe_executions invalid_barrier_owners missing_barrier_obligations \
  missing_barrier_targets <<<"$audit_values"
[[ "$unresolved" -eq 0 ]] ||
  die "Restore review blocked: deletion outbox remains unresolved."
[[ "$account_obligations" -eq 0 ]] ||
  die "Restore review blocked: account deletion remains unresolved."
[[ "$deletion_leases" -eq 0 ]] ||
  die "Restore review blocked: a deletion lease remains live."
[[ "$job_leases" -eq 0 ]] ||
  die "Restore review blocked: a Memory job lease remains live."
[[ "$unsafe_executions" -eq 0 ]] ||
  die "Restore review blocked: provider execution recovery remains unresolved."
[[ "$invalid_barrier_owners" -eq 0 ]] ||
  die "Restore review blocked: source barrier ownership is invalid."
[[ "$missing_barrier_obligations" -eq 0 ]] ||
  die "Restore review blocked: a source barrier lacks its deletion obligation."
[[ "$missing_barrier_targets" -eq 0 ]] ||
  die "Restore review blocked: a deletion obligation lacks its source barrier."

if ! compose exec -T "$RESTORE_REVIEW_MINIO_SERVICE" sh -ceu '
  bucket="$1"
  : "${MINIO_ROOT_USER:?}"
  : "${MINIO_ROOT_PASSWORD:?}"
  mc alias set --quiet restore-review http://127.0.0.1:9000 \
    "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
  mc stat "restore-review/$bucket" >/dev/null 2>&1
' sh "$RESTORE_REVIEW_BUCKET" >/dev/null 2>&1; then
  die "Restore review blocked: private object bucket is unavailable."
fi

assert_isolated_restore_project \
  "$RESTORE_REVIEW_POSTGRES_SERVICE" \
  "$RESTORE_REVIEW_MINIO_SERVICE" \
  "$RESTORE_REVIEW_TOOLS_SERVICE"

audit_sha="$(printf '%s' "$audit_schema:$audit_values" | sha256sum | awk '{ print $1 }')"
audited_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
promotion="$review_directory/promotion.env"
cat >"$promotion" <<PROMOTION
AIQSA_RESTORE_PROMOTION_FORMAT=1
PROMOTION_STATE=PASSED
BACKUP_BUNDLE_SHA256=$RESTORE_REVIEW_BUNDLE_SHA256
BACKUP_CREATED_AT_UTC=$RESTORE_REVIEW_BACKUP_CREATED_AT_UTC
RESTORED_AT_UTC=$RESTORE_REVIEW_RESTORED_AT_UTC
AUDITED_AT_UTC=$audited_at
COMPOSE_PROJECT_NAME=$RESTORE_REVIEW_PROJECT
COMPOSE_CONFIG_SHA256=$RESTORE_REVIEW_COMPOSE_CONFIG_SHA256
DELETION_JOURNAL_STATUS=$journal_status
DELETION_JOURNAL_SHA256=$journal_sha
AUDIT_SCHEMA=$audit_schema
AUDIT_SHA256=$audit_sha
PROMOTION
chmod 600 "$promotion"
(
  cd "$review_directory"
  sha256sum promotion.env >PROMOTION_SHA256SUMS
)
chmod 600 "$review_directory/PROMOTION_SHA256SUMS"

info "Restore review passed. A private promotion receipt was written; no application or provider role was started."
