#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

[[ "${AIQSA_RUN_BACKUP_RESTORE_TEST:-}" == "1" ]] || {
  printf '%s\n' "Backup/restore reconciliation test skipped; set AIQSA_RUN_BACKUP_RESTORE_TEST=1."
  exit 0
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_COMPOSE="$REPOSITORY_ROOT/tests/fixtures/backup-restore/docker-compose.source.yml"
TARGET_COMPOSE="$REPOSITORY_ROOT/ops/backup/docker-compose.restore.yml:$REPOSITORY_ROOT/tests/fixtures/backup-restore/docker-compose.target-test.yml"
KEYRING="current=v1,v1=CwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSo="
WRONG_KEYRING="current=v2,v2=DA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKis="
suffix="$(date -u +%Y%m%d%H%M%S)-$$"
source_project="aiqsa-backup-test-$suffix"
target_project="aiqsa-restore-test-$suffix"
test_root="$(mktemp -d /tmp/aiqsa-backup-restore.XXXXXX)"
test_stage="initialization"
chmod 700 "$test_root"
mkdir -m 700 "$test_root/backups" "$test_root/review"

source_compose() {
  COMPOSE_FILE="$SOURCE_COMPOSE" \
  COMPOSE_PROJECT_NAME="$source_project" \
  AIQSA_MEMORY_FINGERPRINT_KEYRING="$KEYRING" \
  AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
    docker compose "$@"
}

target_compose() {
  local keyring="$1"
  shift
  COMPOSE_FILE="$TARGET_COMPOSE" \
  COMPOSE_PROJECT_NAME="$target_project" \
  AIQSA_IMAGE="${AIQSA_TEST_TOOLS_IMAGE:-aiqsa-dev-app:latest}" \
  AIQSA_MEMORY_FINGERPRINT_KEYRING="$keyring" \
  AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
  AIQSA_RESTORE_BUCKET="aiqsa-restore" \
  AIQSA_RESTORE_POSTGRES_PASSWORD="aiqsa-restore-postgres" \
  AIQSA_RESTORE_S3_SECRET_ACCESS_KEY="aiqsa-restore-object-secret" \
    docker compose "$@"
}

source_sql() {
  local sql="$1"
  source_compose exec -T postgres sh -ceu '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"
  ' sh "$sql"
}

target_sql() {
  local sql="$1"
  target_compose "$KEYRING" exec -T postgres-restore sh -ceu '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -X --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"
  ' sh "$sql"
}

restore_bundle() {
  local keyring="$1"
  local bundle_path="$2"

  COMPOSE_FILE="$TARGET_COMPOSE" \
  COMPOSE_PROJECT_NAME="$target_project" \
  AIQSA_IMAGE="${AIQSA_TEST_TOOLS_IMAGE:-aiqsa-dev-app:latest}" \
  AIQSA_MEMORY_FINGERPRINT_KEYRING="$keyring" \
  AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
  AIQSA_RESTORE_BUCKET="aiqsa-restore" \
  AIQSA_RESTORE_DISPOSABLE_TARGET=YES \
  AIQSA_RESTORE_MINIO_SERVICE=minio-restore \
  AIQSA_RESTORE_POSTGRES_PASSWORD="aiqsa-restore-postgres" \
  AIQSA_RESTORE_POSTGRES_SERVICE=postgres-restore \
  AIQSA_RESTORE_REVIEW_DIRECTORY="$test_root/review" \
  AIQSA_RESTORE_S3_SECRET_ACCESS_KEY="aiqsa-restore-object-secret" \
  AIQSA_RESTORE_TOOLS_SERVICE=restore-tools \
    ops/backup/restore.sh "$bundle_path"
}

make_bundle_variant() {
  local source_bundle="$1"
  local target_bundle="$2"
  local key="$3"
  local value="$4"

  cp -R -- "$source_bundle" "$target_bundle"
  awk -F= -v key="$key" -v value="$value" '
    $1 == key {
      count += 1
      print key "=" value
      next
    }
    { print }
    END { if (count != 1) exit 1 }
  ' "$target_bundle/manifest.env" >"$target_bundle/manifest.env.next"
  mv -- "$target_bundle/manifest.env.next" "$target_bundle/manifest.env"
  (
    cd "$target_bundle"
    sha256sum manifest.env postgres.dump objects.tar >SHA256SUMS
  )
}

cleanup() {
  local status=$?
  trap - EXIT
  target_compose "$KEYRING" down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  source_compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  docker volume rm "${target_project}_target_tools_node_modules" >/dev/null 2>&1 || true
  docker volume rm "${source_project}_source_tools_node_modules" >/dev/null 2>&1 || true
  rm -rf -- "$test_root" || status=1
  exit "$status"
}
on_error() {
  printf 'Backup/restore reconciliation test failed at stage: %s\n' "$test_stage" >&2
}
trap on_error ERR
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cd "$REPOSITORY_ROOT"
test_stage="source-services"
source_compose up -d --wait postgres minio
source_compose run --rm minio-init >/dev/null
source_compose run --rm --no-deps --entrypoint npm migrate-bootstrap \
  --silent run db:generate >/dev/null
source_compose run --rm --no-deps --entrypoint npm migrate-bootstrap \
  --silent run db:migrate:deploy >/dev/null
source_compose run --rm --no-deps --entrypoint npm migrate-bootstrap \
  --silent run db:seed >/dev/null

source_compose run --rm --no-deps --entrypoint /bin/sh minio-init -ceu '
  mc alias set --quiet source "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" \
    "$S3_SECRET_ACCESS_KEY" >/dev/null
  printf restore-fixture | mc pipe "source/$S3_BUCKET/evidence/fixture.bin" >/dev/null
  printf knowledge-restore-fixture | \
    mc pipe "source/$S3_BUCKET/knowledge/backup-source.bin" >/dev/null
' >/dev/null

source_sql "
  INSERT INTO \"MemorySuppression\" (
    \"id\", \"userId\", \"scope\", \"deletionGeneration\",
    \"fingerprintKeyVersion\", \"normalizationVersion\"
  )
  SELECT
    'backup-restore-suppression',
    settings.\"userId\",
    'ALL'::\"MemorySuppressionScope\",
    settings.\"memoryGeneration\",
    'v1',
    'memory-lexical-v1'
  FROM \"UserMemorySettings\" AS settings
  WHERE settings.\"userId\" = '00000000-0000-4000-8000-000000000001';
" >/dev/null
source_sql "
  INSERT INTO \"KnowledgeSource\" (
    \"id\", \"ownerUserId\", \"name\", \"description\", \"tags\",
    \"version\", \"createdAt\", \"updatedAt\"
  ) VALUES (
    'backup-restore-knowledge-source',
    '00000000-0000-4000-8000-000000000001',
    'Backup restore deletion fixture',
    '',
    ARRAY[]::text[],
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
  INSERT INTO \"KnowledgeSourceVersion\" (
    \"id\", \"sourceId\", \"ownerUserId\", \"versionNumber\", \"fileName\",
    \"mimeType\", \"byteSize\", \"checksum\", \"originalStorageKey\", \"createdAt\"
  ) VALUES (
    'backup-restore-knowledge-version',
    'backup-restore-knowledge-source',
    '00000000-0000-4000-8000-000000000001',
    1,
    'backup-source.bin',
    'application/octet-stream',
    25,
    repeat('e', 64),
    'knowledge/backup-source.bin',
    CURRENT_TIMESTAMP
  );
  UPDATE \"KnowledgeSource\"
  SET \"currentVersionId\" = 'backup-restore-knowledge-version',
      \"trashedAt\" = CURRENT_TIMESTAMP,
      \"deletionRequestedAt\" = CURRENT_TIMESTAMP,
      \"version\" = 2,
      \"updatedAt\" = CURRENT_TIMESTAMP
  WHERE \"id\" = 'backup-restore-knowledge-source';
  INSERT INTO \"KnowledgeDeletionJob\" (
    \"id\", \"ownerUserId\", \"targetType\", \"targetId\", \"state\",
    \"createdAt\", \"updatedAt\"
  ) VALUES (
    'backup-restore-knowledge-deletion',
    '00000000-0000-4000-8000-000000000001',
    'SOURCE'::\"KnowledgeDeletionTargetType\",
    'backup-restore-knowledge-source',
    'PENDING'::\"KnowledgeDeletionState\",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
" >/dev/null
source_user_count="$(source_sql 'SELECT count(*) FROM "User";')"
[[ "$source_user_count" =~ ^[0-9]+$ && "$source_user_count" -gt 0 ]]

source_compose up -d app memory-worker
test_stage="write-quiesced-backup"
COMPOSE_FILE="$SOURCE_COMPOSE" \
COMPOSE_PROJECT_NAME="$source_project" \
AIQSA_MEMORY_FINGERPRINT_KEYRING="$KEYRING" \
AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
  ops/backup/create.sh "$test_root/backups" >/dev/null
source_compose ps --services --status running app | grep -Fxq app
source_compose ps --services --status running memory-worker | grep -Fxq memory-worker

bundle="$(find "$test_root/backups" -mindepth 1 -maxdepth 1 -type d -name 'aiqsa-backup-*' -print -quit)"
[[ -n "$bundle" ]]
ops/backup/restore.sh --verify-only "$bundle" >/dev/null

legacy_format_bundle="$test_root/legacy-format-bundle"
legacy_schema_bundle="$test_root/legacy-schema-bundle"
make_bundle_variant "$bundle" "$legacy_format_bundle" AIQSA_BACKUP_FORMAT 1
make_bundle_variant "$bundle" "$legacy_schema_bundle" AIQSA_BACKUP_SCHEMA pre-memory

target_compose "$WRONG_KEYRING" up -d --wait postgres-restore minio-restore
test_stage="legacy-format-rejection"
if restore_bundle "$KEYRING" "$legacy_format_bundle" \
  >"$test_root/legacy-format.log" 2>&1; then
  printf '%s\n' "Expected legacy-format restore rejection." >&2
  exit 1
fi
grep -Fq "Backup format is incompatible" "$test_root/legacy-format.log"

test_stage="legacy-schema-rejection"
if restore_bundle "$KEYRING" "$legacy_schema_bundle" \
  >"$test_root/legacy-schema.log" 2>&1; then
  printf '%s\n' "Expected legacy-schema restore rejection." >&2
  exit 1
fi
grep -Fq "Backup schema is incompatible" "$test_root/legacy-schema.log"

test_stage="legacy-rejection-no-mutation-audit"
target_relation_count="$(target_sql "
  SELECT count(*)
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
")"
target_relation_count="${target_relation_count//[[:space:]]/}"
[[ "$target_relation_count" -eq 0 ]]

test_stage="missing-key-rejection"
if restore_bundle "$WRONG_KEYRING" "$bundle" >"$test_root/missing-key.log" 2>&1; then
  printf '%s\n' "Expected missing-key restore rejection." >&2
  exit 1
fi
if ! grep -Fq "Memory suppression key preflight failed" "$test_root/missing-key.log"; then
  sed -n '1,20p' "$test_root/missing-key.log" >&2
  exit 1
fi
test_stage="missing-key-no-mutation-audit"
target_relation_count="$(target_sql "
  SELECT count(*)
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname NOT LIKE 'pg_toast%'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
")"
target_relation_count="${target_relation_count//[[:space:]]/}"
[[ "$target_relation_count" -eq 0 ]]

restore_bundle "$KEYRING" "$bundle" >/dev/null

test_stage="restored-data-audit"
restored_user_count="$(target_sql 'SELECT count(*) FROM "User";')"
restored_user_count="${restored_user_count//[[:space:]]/}"
[[ "$restored_user_count" -eq "$source_user_count" ]]
restored_knowledge_source_count="$(target_sql \
  'SELECT count(*) FROM "KnowledgeSource" WHERE "id" = '\''backup-restore-knowledge-source'\'';')"
restored_knowledge_source_count="${restored_knowledge_source_count//[[:space:]]/}"
[[ "$restored_knowledge_source_count" -eq 1 ]]
target_compose "$KEYRING" exec -T minio-restore sh -ceu '
  mc alias set --quiet target http://127.0.0.1:9000 \
    "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc stat "target/aiqsa-restore/evidence/fixture.bin" >/dev/null
  mc stat "target/aiqsa-restore/knowledge/backup-source.bin" >/dev/null
'
target_compose "$KEYRING" run --rm --no-deps --entrypoint npm restore-tools \
  --silent run db:generate >/dev/null

target_sql "
  INSERT INTO \"MemoryDeletionOutbox\" (
    \"id\", \"userId\", \"operation\", \"targetType\", \"targetId\", \"memoryGeneration\"
  )
  SELECT
    'restore-test-account-obligation',
    settings.\"userId\",
    'ACCOUNT_MEMORY_DELETE'::\"MemoryDeletionOperation\",
    'ACCOUNT@memory-account-delete-v1',
    settings.\"userId\",
    settings.\"memoryGeneration\"
  FROM \"UserMemorySettings\" AS settings
  WHERE settings.\"userId\" = '00000000-0000-4000-8000-000000000001';
" >/dev/null
test_stage="unresolved-account-rejection"
if COMPOSE_FILE="$TARGET_COMPOSE" \
  COMPOSE_PROJECT_NAME="$target_project" \
  AIQSA_IMAGE="${AIQSA_TEST_TOOLS_IMAGE:-aiqsa-dev-app:latest}" \
  AIQSA_MEMORY_FINGERPRINT_KEYRING="$KEYRING" \
  AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
  AIQSA_RESTORE_BUCKET="aiqsa-restore" \
  AIQSA_RESTORE_DISPOSABLE_TARGET=YES \
  AIQSA_RESTORE_POSTGRES_PASSWORD="aiqsa-restore-postgres" \
  AIQSA_RESTORE_S3_SECRET_ACCESS_KEY="aiqsa-restore-object-secret" \
    ops/backup/review.sh --deletion-journal-not-required "$test_root/review" \
    >"$test_root/unresolved.log" 2>&1; then
  printf '%s\n' "Expected unresolved account-deletion rejection." >&2
  exit 1
fi
grep -Fq "deletion reconciliation remains incomplete" "$test_root/unresolved.log"
[[ ! -e "$test_root/review/promotion.env" ]]
blocked_knowledge_source_count="$(target_sql \
  'SELECT count(*) FROM "KnowledgeSource" WHERE "id" = '\''backup-restore-knowledge-source'\'';')"
blocked_knowledge_source_count="${blocked_knowledge_source_count//[[:space:]]/}"
[[ "$blocked_knowledge_source_count" -eq 1 ]]
target_compose "$KEYRING" exec -T minio-restore sh -ceu '
  mc alias set --quiet target http://127.0.0.1:9000 \
    "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc stat "target/aiqsa-restore/knowledge/backup-source.bin" >/dev/null
'

target_sql "
  DELETE FROM \"MemoryDeletionOutbox\"
  WHERE \"id\" = 'restore-test-account-obligation';
" >/dev/null
test_stage="successful-review"
COMPOSE_FILE="$TARGET_COMPOSE" \
COMPOSE_PROJECT_NAME="$target_project" \
AIQSA_IMAGE="${AIQSA_TEST_TOOLS_IMAGE:-aiqsa-dev-app:latest}" \
AIQSA_MEMORY_FINGERPRINT_KEYRING="$KEYRING" \
AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
AIQSA_RESTORE_BUCKET="aiqsa-restore" \
AIQSA_RESTORE_DISPOSABLE_TARGET=YES \
AIQSA_RESTORE_POSTGRES_PASSWORD="aiqsa-restore-postgres" \
AIQSA_RESTORE_S3_SECRET_ACCESS_KEY="aiqsa-restore-object-secret" \
  ops/backup/review.sh --deletion-journal-not-required "$test_root/review" >/dev/null
(
  cd "$test_root/review"
  sha256sum --check --strict PROMOTION_SHA256SUMS >/dev/null
)
grep -Fxq "PROMOTION_STATE=PASSED" "$test_root/review/promotion.env"
grep -Fxq "DELETION_JOURNAL_STATUS=NOT_REQUIRED" "$test_root/review/promotion.env"
purged_knowledge_source_count="$(target_sql \
  'SELECT count(*) FROM "KnowledgeSource" WHERE "id" = '\''backup-restore-knowledge-source'\'';')"
purged_knowledge_source_count="${purged_knowledge_source_count//[[:space:]]/}"
[[ "$purged_knowledge_source_count" -eq 0 ]]
knowledge_deletion_state="$(target_sql \
  'SELECT "state"::text FROM "KnowledgeDeletionJob" WHERE "id" = '\''backup-restore-knowledge-deletion'\'';')"
knowledge_deletion_state="${knowledge_deletion_state//[[:space:]]/}"
[[ "$knowledge_deletion_state" == "SUCCEEDED" ]]
if target_compose "$KEYRING" exec -T minio-restore sh -ceu '
  mc alias set --quiet target http://127.0.0.1:9000 \
    "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc stat "target/aiqsa-restore/knowledge/backup-source.bin" >/dev/null 2>&1
'; then
  printf '%s\n' "Knowledge restore reconciliation retained a purged Source object." >&2
  exit 1
fi

running_services="$(target_compose "$KEYRING" ps --services --status running | LC_ALL=C sort)"
[[ "$running_services" == $'minio-restore\npostgres-restore' ]]

test_stage="missing-memory-source-rejection"
source_sql 'DROP TABLE "MemorySuppression";' >/dev/null
if COMPOSE_FILE="$SOURCE_COMPOSE" \
  COMPOSE_PROJECT_NAME="$source_project" \
  AIQSA_MEMORY_FINGERPRINT_KEYRING="$KEYRING" \
  AIQSA_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
    ops/backup/create.sh "$test_root/rejected-backups" \
    >"$test_root/missing-memory.log" 2>&1; then
  printf '%s\n' "Expected missing-Memory source rejection." >&2
  exit 1
fi
grep -Fq "does not have the current backup schema" "$test_root/missing-memory.log"
source_compose ps --services --status running app | grep -Fxq app
source_compose ps --services --status running memory-worker | grep -Fxq memory-worker
if find "$test_root/rejected-backups" -mindepth 1 -print -quit | grep -q .; then
  printf '%s\n' "Missing-Memory rejection published an unexpected bundle." >&2
  exit 1
fi

printf '%s\n' "Backup/restore reconciliation test passed."
