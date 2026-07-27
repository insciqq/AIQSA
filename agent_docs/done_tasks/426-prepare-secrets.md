# 426-prepare-secrets

Status: done
Completed: 2026-07-27
Depends on: none

## Goal

Make first installation create a secure ready-to-edit .env without manual secret generation

## Scope

- Add a root `prepare-secrets.sh` that creates `.env` only when absent, prompts only for the initial administrator email, and generates every required secret plus the initial password.
- Treat any existing target as an untouched successful skip, refuse ambiguous/unsafe input for a new target, publish atomically, and keep the new `.env` mode `0600`.
- Update public onboarding, environment, security, and verification documentation.

## Out Of Scope

- Unrelated product changes.

## Acceptance Criteria

- `bash prepare-secrets.sh` is sufficient to create a first-install `.env` from `.env.example` in an interactive terminal.
- `--admin-email` supports non-interactive preparation, and any existing target is skipped without being read or mutated, including its permissions.
- Generated values satisfy the documented entropy/encoding contracts and no infrastructure secret is printed.
- README leads with the helper while retaining a documented manual path.

## Tests

- `docker compose -f docker-compose.dev.yml exec -T app npx vitest run tests/harness/prepare-secrets.test.ts`.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.

## Done Notes

- Added executable root `prepare-secrets.sh`: a fresh interactive run asks only
  for the administrator email, while `--admin-email` supports unattended setup.
  The helper independently generates the session, encryption, PostgreSQL,
  MinIO, and initial-administrator values, stages mode `0600`, publishes through
  a non-replacing hard link, prints only the new administrator credential, and
  treats every existing target as an unread, byte-for-byte untouched success.
- Added four temporary-target harness cases for value formats, decoded
  encryption-key length, permissions, non-disclosure, existing-file skip, and
  failure cleanup. Updated README, configuration, env/security/testing
  contracts, `.env.example`, the private release runbook, and Docker context
  exclusions for the new onboarding path.
- Verification passed: `bash -n prepare-secrets.sh`; focused harness `4/4`;
  `npm run docs:check`; and routine `npm run check` with 311 test files / 2580
  tests passed and 14 opt-in tests skipped. The first routine run exposed a
  transient shared-dev-database collision in two unrelated attachment-retention
  tests; both passed independently, and the unchanged full retry passed.
