#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

HEAVY_MIGRATION="20260818073000_knowledge_ingestion_v2"
EVIDENCE_FORMAT="1"
MINIMUM_FREE_KB=1048576
REWRITE_RESERVE_KB=524288

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1" >&2
}

usage() {
  printf '%s\n' \
    "Usage: ops-knowledge-cutover.sh preflight|reconcile RELEASE SHARED_ENV PROJECT REVISION EVIDENCE OPERATION_LOCK [BATCH_SIZE]" \
    "" \
    "Runs the guarded existing-install Knowledge cutover while application writers" \
    "are stopped. Preflight records the heavyweight migration capacity/lock plan;" \
    "reconcile runs the resumable V1-to-Source backfill and requires zero discrepancies." \
    "The caller must hold the installation operation lock for the complete sequence."
}

if [[ "$#" -eq 1 && ("$1" == "--help" || "$1" == "-h") ]]; then
  usage
  exit 0
fi

[[ "$#" -ge 7 && "$#" -le 8 ]] || {
  usage >&2
  exit 1
}

phase="$1"
release_root="$2"
shared_env="$3"
compose_project="$4"
revision="$5"
evidence_file="$6"
operation_lock="$7"
batch_size="${8:-100}"

[[ "$phase" == "preflight" || "$phase" == "reconcile" ]] || die "Phase must be preflight or reconcile."
[[ "$release_root" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "Release path is invalid."
[[ "$shared_env" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "Shared environment path is invalid."
[[ "$compose_project" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Compose project name is invalid."
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "Revision is invalid."
[[ "$evidence_file" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "Evidence path is invalid."
[[ "$operation_lock" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "Operation lock path is invalid."
[[ "$batch_size" =~ ^[0-9]+$ && "$batch_size" -ge 1 && "$batch_size" -le 1000 ]] ||
  die "Batch size must be between 1 and 1000."

[[ ! -L "$release_root" ]] || die "Release directory must not be a symlink."
[[ ! -L "$shared_env" ]] || die "Shared environment file must not be a symlink."
release_root="$(readlink -f "$release_root")"
shared_env="$(readlink -f "$shared_env")"
evidence_parent="$(readlink -f "$(dirname -- "$evidence_file")")"
[[ -d "$release_root" && ! -L "$release_root" ]] || die "Release directory is invalid."
[[ -f "$release_root/docker-compose.yml" && ! -L "$release_root/docker-compose.yml" ]] ||
  die "Release Compose file is invalid."
[[ -f "$shared_env" && ! -L "$shared_env" ]] || die "Shared environment file is invalid."
[[ -d "$evidence_parent" && ! -L "$evidence_parent" ]] || die "Evidence directory is invalid."
[[ "$evidence_file" == "$evidence_parent/knowledge-cutover-$revision.env" ]] ||
  die "Evidence filename must be bound to the release revision."
[[ ! -L "$evidence_file" ]] || die "Evidence file must not be a symlink."
[[ -f "$operation_lock" && ! -L "$operation_lock" ]] || die "Operation lock file is invalid."
[[ "$(stat -c %a "$operation_lock")" == "600" ]] || die "Operation lock must have mode 0600."

for command in awk date dirname docker flock grep readlink sed stat; do
  command -v "$command" >/dev/null 2>&1 || die "Required command is unavailable: $command"
done
if flock -n "$operation_lock" true; then
  die "Caller must hold the shared deployment/backup/prune operation lock."
fi

compose() {
  local -a args=(docker compose --env-file "$shared_env")
  if [[ -f "$release_root/.env.release" && ! -L "$release_root/.env.release" ]]; then
    args+=(--env-file "$release_root/.env.release")
  fi
  if grep -Eq '^[[:space:]]{2}app-prod:' "$release_root/docker-compose.yml"; then
    args+=(--profile prod)
  fi
  (
    cd "$release_root"
    export COMPOSE_PROJECT_NAME="$compose_project"
    "${args[@]}" "$@"
  )
}

service_exists() {
  compose config --services 2>/dev/null | grep -Fxq "$1"
}

service_running() {
  compose ps --services --status running "$1" 2>/dev/null | grep -Fxq "$1"
}

resolve_service() {
  local current="$1"
  local legacy="$2"
  if service_exists "$current"; then
    printf '%s' "$current"
  elif service_exists "$legacy"; then
    printf '%s' "$legacy"
  else
    return 1
  fi
}

postgres_service="$(resolve_service postgres postgres-prod)" || die "Release Compose is missing PostgreSQL."
minio_service="$(resolve_service minio minio-prod)" || die "Release Compose is missing private object storage."
app_service="$(resolve_service app app-prod)" || die "Release Compose is missing the application."
memory_worker_service="$(resolve_service memory-worker memory-worker-prod 2>/dev/null || true)"
tools_service="$(resolve_service migrate-bootstrap migrate-bootstrap-prod 2>/dev/null || true)"

postgres_scalar() {
  local sql="$1"
  compose exec -T "$postgres_service" sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"
  ' sh "$sql" </dev/null
}

manifest_value() {
  local file="$1"
  local key="$2"
  awk -F= -v wanted="$key" '
    $1 == wanted {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$file"
}

write_evidence() {
  local content="$1"
  local temporary
  temporary="$(mktemp "$evidence_parent/.knowledge-cutover-$revision.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$content" >"$temporary"
  mv -f -- "$temporary" "$evidence_file"
}

assert_writer_quiescence() {
  service_running "$postgres_service" || die "PostgreSQL must be running for Knowledge cutover."
  service_running "$minio_service" || die "Private object storage must be running for Knowledge cutover."
  ! service_running "$app_service" || die "Application writer must be stopped for Knowledge cutover."
  if [[ -n "$memory_worker_service" ]]; then
    ! service_running "$memory_worker_service" || die "Memory worker must be stopped for schema migration."
  fi
}

migration_applied() {
  local count
  count="$(postgres_scalar "
    SELECT count(*)
    FROM \"_prisma_migrations\"
    WHERE migration_name = '$HEAVY_MIGRATION'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL;
  " 2>/dev/null)" || return 1
  count="${count//[[:space:]]/}"
  [[ "$count" == "1" ]]
}

if [[ "$phase" == "preflight" ]]; then
  if [[ -e "$evidence_file" ]]; then
    [[ -f "$evidence_file" && "$(stat -c %a "$evidence_file")" == "600" ]] ||
      die "Existing Knowledge cutover evidence is invalid."
    [[ "$(manifest_value "$evidence_file" AIQSA_KNOWLEDGE_CUTOVER_EVIDENCE_FORMAT)" == "$EVIDENCE_FORMAT" ]] ||
      die "Existing Knowledge cutover evidence format is incompatible."
    [[ "$(manifest_value "$evidence_file" REVISION)" == "$revision" ]] ||
      die "Existing Knowledge cutover evidence belongs to another revision."
    [[ "$(manifest_value "$evidence_file" CUTOVER_STATE)" == "PREFLIGHT_PASSED" ]] ||
      die "Existing Knowledge cutover evidence is not safely repeatable."
  fi
  assert_writer_quiescence

  unsafe_sessions="$(postgres_scalar '
    SELECT count(*)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND (
        state = '\''idle in transaction'\''
        OR backend_xid IS NOT NULL
        OR wait_event_type = '\''Lock'\''
      );
  ' 2>/dev/null)" || die "Could not inspect PostgreSQL transaction/lock state."
  unsafe_sessions="${unsafe_sessions//[[:space:]]/}"
  [[ "$unsafe_sessions" =~ ^[0-9]+$ ]] || die "PostgreSQL lock preflight returned invalid evidence."
  [[ "$unsafe_sessions" -eq 0 ]] || die "Knowledge migration preflight found an open transaction or lock wait."

  chunk_rows="$(postgres_scalar 'SELECT count(*) FROM "KnowledgeChunk";' 2>/dev/null)" ||
    die "Could not count existing Knowledge chunks."
  chunk_bytes="$(postgres_scalar \
    'SELECT pg_total_relation_size('\''public."KnowledgeChunk"'\''::regclass);' 2>/dev/null)" ||
    die "Could not size the existing Knowledge chunk relation."
  chunk_rows="${chunk_rows//[[:space:]]/}"
  chunk_bytes="${chunk_bytes//[[:space:]]/}"
  [[ "$chunk_rows" =~ ^[0-9]+$ && "$chunk_bytes" =~ ^[0-9]+$ ]] ||
    die "Knowledge migration sizing returned invalid evidence."
  [[ "$chunk_bytes" -le 2000000000000000000 ]] ||
    die "Knowledge chunk relation size exceeds the guarded arithmetic bound."

  available_kb="$(compose exec -T "$postgres_service" sh -ceu \
    "df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print \\\$4 }'" 2>/dev/null)" ||
    die "Could not inspect PostgreSQL volume capacity."
  available_kb="${available_kb//[[:space:]]/}"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || die "PostgreSQL capacity preflight returned invalid evidence."

  initial_migration_state="pending"
  downtime_required="yes"
  relation_kb=$(( (chunk_bytes + 1023) / 1024 ))
  required_kb=$(( relation_kb * 3 + REWRITE_RESERVE_KB ))
  if [[ "$required_kb" -lt "$MINIMUM_FREE_KB" ]]; then
    required_kb="$MINIMUM_FREE_KB"
  fi
  if migration_applied; then
    initial_migration_state="already_applied"
    downtime_required="backfill_only"
    required_kb=0
  elif [[ "$available_kb" -lt "$required_kb" ]]; then
    die "Knowledge migration capacity preflight failed; PostgreSQL free space is below the rewrite reserve."
  fi

  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_evidence "$(printf '%s\n' \
    "AIQSA_KNOWLEDGE_CUTOVER_EVIDENCE_FORMAT=$EVIDENCE_FORMAT" \
    "REVISION=$revision" \
    "HEAVY_MIGRATION=$HEAVY_MIGRATION" \
    "HEAVY_MIGRATION_INITIAL_STATE=$initial_migration_state" \
    "KNOWLEDGE_CHUNK_ROWS=$chunk_rows" \
    "KNOWLEDGE_CHUNK_TOTAL_BYTES=$chunk_bytes" \
    "POSTGRES_AVAILABLE_KB=$available_kb" \
    "POSTGRES_REQUIRED_KB=$required_kb" \
    "UNSAFE_DATABASE_SESSIONS=0" \
    "OPERATION_LOCK_VERIFIED=yes" \
    "DOWNTIME_REQUIRED=$downtime_required" \
    "LOCK_PLAN=writers_stopped_access_exclusive_and_index_build" \
    "ROLLBACK_BOUNDARY=old_code_safe_before_migration_only" \
    "PREFLIGHT_AT_UTC=$checked_at" \
    "CUTOVER_STATE=PREFLIGHT_PASSED")"
  info "Knowledge migration preflight passed: state=$initial_migration_state chunks=$chunk_rows required_kb=$required_kb."
  exit 0
fi

[[ -f "$evidence_file" ]] || die "Knowledge cutover preflight evidence is missing."
[[ "$(stat -c %a "$evidence_file")" == "600" ]] || die "Knowledge cutover evidence must have mode 0600."
[[ "$(manifest_value "$evidence_file" AIQSA_KNOWLEDGE_CUTOVER_EVIDENCE_FORMAT)" == "$EVIDENCE_FORMAT" ]] ||
  die "Knowledge cutover evidence format is incompatible."
[[ "$(manifest_value "$evidence_file" REVISION)" == "$revision" ]] ||
  die "Knowledge cutover evidence revision does not match."
[[ "$(manifest_value "$evidence_file" HEAVY_MIGRATION)" == "$HEAVY_MIGRATION" ]] ||
  die "Knowledge cutover evidence migration does not match."
[[ "$(manifest_value "$evidence_file" CUTOVER_STATE)" == "PREFLIGHT_PASSED" ]] ||
  die "Knowledge cutover preflight is not pending reconciliation."
assert_writer_quiescence
[[ -n "$tools_service" ]] || die "Release Compose is missing migration/bootstrap tools."
migration_applied || die "Heavyweight Knowledge migration is not applied; reconciliation is blocked."

backfill_output=""
if ! backfill_output="$(compose run --rm -T --no-deps --entrypoint npm "$tools_service" \
  --silent run knowledge:sources:backfill -- --batch-size="$batch_size" 2>/dev/null)"; then
  die "Knowledge Source backfill failed; application writers remain stopped."
fi
status_line="$(printf '%s\n' "$backfill_output" | awk '
  /^\{.*"status":"reconciled".*\}$/ {
    count += 1
    line = $0
  }
  END {
    if (count != 1) exit 1
    print line
  }
')" || die "Knowledge Source backfill did not emit one reconciled aggregate result."

json_uint() {
  local key="$1"
  local value
  value="$(sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\\1/p" <<<"$status_line")"
  [[ "$value" =~ ^[0-9]+$ ]] || die "Knowledge Source backfill result is missing $key."
  printf '%s' "$value"
}

processed_documents="$(json_uint processedDocuments)"
discrepancies="$(json_uint discrepancies)"
skipped_profileless="$(json_uint skippedProfilelessCandidates)"
[[ "$discrepancies" -eq 0 ]] || die "Knowledge Source reconciliation is nonzero; application writers remain stopped."
[[ "$skipped_profileless" -eq 0 ]] || die "Knowledge Source backfill skipped profileless data; application writers remain stopped."

initial_migration_state="$(manifest_value "$evidence_file" HEAVY_MIGRATION_INITIAL_STATE)"
chunk_rows="$(manifest_value "$evidence_file" KNOWLEDGE_CHUNK_ROWS)"
chunk_bytes="$(manifest_value "$evidence_file" KNOWLEDGE_CHUNK_TOTAL_BYTES)"
available_kb="$(manifest_value "$evidence_file" POSTGRES_AVAILABLE_KB)"
required_kb="$(manifest_value "$evidence_file" POSTGRES_REQUIRED_KB)"
downtime_required="$(manifest_value "$evidence_file" DOWNTIME_REQUIRED)"
preflight_at="$(manifest_value "$evidence_file" PREFLIGHT_AT_UTC)"
reconciled_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_evidence "$(printf '%s\n' \
  "AIQSA_KNOWLEDGE_CUTOVER_EVIDENCE_FORMAT=$EVIDENCE_FORMAT" \
  "REVISION=$revision" \
  "HEAVY_MIGRATION=$HEAVY_MIGRATION" \
  "HEAVY_MIGRATION_INITIAL_STATE=$initial_migration_state" \
  "HEAVY_MIGRATION_FINAL_STATE=applied" \
  "KNOWLEDGE_CHUNK_ROWS=$chunk_rows" \
  "KNOWLEDGE_CHUNK_TOTAL_BYTES=$chunk_bytes" \
  "POSTGRES_AVAILABLE_KB=$available_kb" \
  "POSTGRES_REQUIRED_KB=$required_kb" \
  "UNSAFE_DATABASE_SESSIONS=0" \
  "OPERATION_LOCK_VERIFIED=yes" \
  "DOWNTIME_REQUIRED=$downtime_required" \
  "LOCK_PLAN=writers_stopped_access_exclusive_and_index_build" \
  "ROLLBACK_BOUNDARY=profile_pointer_only_after_migration_no_schema_downgrade" \
  "BACKFILL_BATCH_SIZE=$batch_size" \
  "BACKFILL_PROCESSED_DOCUMENTS=$processed_documents" \
  "RECONCILIATION_DISCREPANCIES=0" \
  "SKIPPED_PROFILELESS_CANDIDATES=0" \
  "PREFLIGHT_AT_UTC=$preflight_at" \
  "RECONCILED_AT_UTC=$reconciled_at" \
  "CUTOVER_STATE=RECONCILED")"
info "Knowledge existing-install cutover reconciled: processed=$processed_documents discrepancies=0."
