#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REVISION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
temporary_root="$(mktemp -d /tmp/aiqsa-knowledge-cutover-test.XXXXXX)"
release_root="$temporary_root/release"
shared_env="$temporary_root/shared.env"
evidence_root="$temporary_root/evidence"
evidence_file="$evidence_root/knowledge-cutover-$REVISION.env"
operation_lock="$temporary_root/operation.lock"
trace_file="$temporary_root/trace"

cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

fail() {
  printf 'Knowledge cutover test failed: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$release_root" "$evidence_root" "$temporary_root/bin"
printf 'services:\n  app:\n  memory-worker:\n  migrate-bootstrap:\n  minio:\n  postgres:\n' \
  >"$release_root/docker-compose.yml"
printf 'AIQSA_POSTGRES_PASSWORD=fixture\n' >"$shared_env"
chmod 600 "$shared_env"
: >"$trace_file"
: >"$operation_lock"
chmod 600 "$operation_lock"

cat >"$temporary_root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >>"$TRACE_FILE"

[[ "${1:-}" == "compose" ]] || exit 1
shift
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    config|exec|ps|run)
      command="$1"
      shift
      break
      ;;
    *) shift ;;
  esac
done

case "${command:-}" in
  config)
    printf '%s\n' app memory-worker migrate-bootstrap minio postgres
    ;;
  ps)
    case "$*" in
      *'--services --status running postgres'*) printf 'postgres\n' ;;
      *'--services --status running minio'*) printf 'minio\n' ;;
      *'--services --status running app'*)
        [[ "${FAKE_APP_RUNNING:-0}" != "1" ]] || printf 'app\n'
        ;;
      *'--services --status running memory-worker'*)
        [[ "${FAKE_MEMORY_RUNNING:-0}" != "1" ]] || printf 'memory-worker\n'
        ;;
    esac
    ;;
  exec)
    case "$*" in
      *pg_stat_activity*) printf '%s\n' "${FAKE_UNSAFE_SESSIONS:-0}" ;;
      *'count(*) FROM "KnowledgeChunk"'*) printf '10\n' ;;
      *pg_total_relation_size*) printf '1048576\n' ;;
      *'_prisma_migrations'*) printf '%s\n' "${FAKE_MIGRATION_APPLIED:-0}" ;;
      *'df -Pk /var/lib/postgresql/data'*) printf '%s\n' "${FAKE_AVAILABLE_KB:-2097152}" ;;
      *) exit 2 ;;
    esac
    ;;
  run)
    [[ "${FAKE_BACKFILL_FAIL:-0}" != "1" ]] || exit 3
    discrepancies="${FAKE_DISCREPANCIES:-0}"
    skipped="${FAKE_SKIPPED_PROFILELESS:-0}"
    status="reconciled"
    if [[ "$discrepancies" != "0" || "$skipped" != "0" ]]; then
      status="incomplete"
    fi
    printf '{"processedDocuments":10,"reconciliation":{"discrepancies":%s},"skippedProfilelessCandidates":%s,"snapshots":{"materializedBases":1},"status":"%s"}\n' \
      "$discrepancies" "$skipped" "$status"
    ;;
  *) exit 1 ;;
esac
DOCKER
chmod 700 "$temporary_root/bin/docker"

if PATH="$temporary_root/bin:$PATH" TRACE_FILE="$trace_file" \
  bash "$REPOSITORY_ROOT/scripts/ops-knowledge-cutover.sh" preflight \
    "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
    "$operation_lock" >/dev/null 2>&1; then
  fail "cutover accepted an unheld operation lock"
fi
[[ ! -e "$evidence_file" ]] || fail "lock rejection published evidence"

exec 9>>"$operation_lock"
flock -n 9 || fail "could not hold the fixture operation lock"

run_cutover() {
  PATH="$temporary_root/bin:$PATH" \
  TRACE_FILE="$trace_file" \
    bash "$REPOSITORY_ROOT/scripts/ops-knowledge-cutover.sh" "$@"
}

if FAKE_APP_RUNNING=1 run_cutover preflight \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" \
  >/dev/null 2>&1; then
  fail "preflight accepted a running application writer"
fi
[[ ! -e "$evidence_file" ]] || fail "writer rejection published evidence"

if FAKE_AVAILABLE_KB=1000 run_cutover preflight \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" \
  >/dev/null 2>&1; then
  fail "preflight accepted insufficient PostgreSQL capacity"
fi
[[ ! -e "$evidence_file" ]] || fail "capacity rejection published evidence"

run_cutover preflight \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" \
  >/dev/null
grep -Fxq 'CUTOVER_STATE=PREFLIGHT_PASSED' "$evidence_file" ||
  fail "preflight evidence is incomplete"
grep -Fxq 'HEAVY_MIGRATION_INITIAL_STATE=pending' "$evidence_file" ||
  fail "preflight did not record the pending migration"
grep -Fxq 'POSTGRES_REQUIRED_KB=1048576' "$evidence_file" ||
  fail "preflight did not record the rewrite reserve"
run_cutover preflight \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" \
  >/dev/null
grep -Fxq 'CUTOVER_STATE=PREFLIGHT_PASSED' "$evidence_file" ||
  fail "safe pre-migration preflight retry did not remain repeatable"

if run_cutover reconcile \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" 25 \
  >/dev/null 2>&1; then
  fail "reconciliation ran before the heavyweight migration"
fi
grep -Fxq 'CUTOVER_STATE=PREFLIGHT_PASSED' "$evidence_file" ||
  fail "pre-migration rejection mutated evidence"

if FAKE_MIGRATION_APPLIED=1 FAKE_DISCREPANCIES=1 run_cutover reconcile \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" 25 \
  >/dev/null 2>&1; then
  fail "reconciliation accepted nonzero discrepancies"
fi
grep -Fxq 'CUTOVER_STATE=PREFLIGHT_PASSED' "$evidence_file" ||
  fail "failed reconciliation mutated evidence"

FAKE_MIGRATION_APPLIED=1 run_cutover reconcile \
  "$release_root" "$shared_env" aiqsa "$REVISION" "$evidence_file" \
  "$operation_lock" 25 \
  >/dev/null
grep -Fxq 'CUTOVER_STATE=RECONCILED' "$evidence_file" ||
  fail "successful reconciliation did not publish terminal evidence"
grep -Fxq 'RECONCILIATION_DISCREPANCIES=0' "$evidence_file" ||
  fail "successful reconciliation omitted the zero-discrepancy gate"
grep -Fxq 'BACKFILL_BATCH_SIZE=25' "$evidence_file" ||
  fail "successful reconciliation omitted the bounded batch"
[[ "$(stat -c %a "$evidence_file")" == "600" ]] || fail "evidence mode is not 0600"

printf 'Knowledge cutover test passed.\n'
