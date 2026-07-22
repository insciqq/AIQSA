# TESTING

## Default Workflow

AIQSA has one routine application check. Start the isolated development stack, then run:

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec -T app npm run check
```

`check` runs compact documentation sanity, ESLint, TypeScript, and the application Vitest suite. Run it once near task completion, not after every edit.

While implementing, run only the smallest relevant test set:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run <test-files>
docker compose -f docker-compose.dev.yml exec -T app npm run lint
docker compose -f docker-compose.dev.yml exec -T app npm run typecheck
```

The default `docker-compose.yml` is an operator installation with persistent user data and is never the routine test target. A one-off `docker compose -f docker-compose.dev.yml run --rm app ...` is also valid, but it may start dependencies and is usually slower.

## Browser Integration

Run Playwright only when behavior crosses the browser/server boundary, routing, auth/session state, focus/inert behavior, responsive input, or streaming integration:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npm run test:e2e
```

This is intentionally destructive verification inside the `aiqsa-dev` project. It may reset its database, replace seeded state, and write to its object bucket. Do not run E2E concurrently with development or another check. If it is interrupted, use `docker compose -f docker-compose.dev.yml down --remove-orphans`; use the same command with `-v` when a complete development-stack reset is acceptable. Neither command targets the default installation volumes.

The reset restores the ordinary local login `operator@aiqsa.local` / `AIQSA-local-2026!`, and auth browser coverage signs in through the visible password form. The credential is a public local fixture and is not safe for an exposed stack.

The retained Playwright specs cover registration, auth/session isolation, admin authorization, the critical conversation workspace, and local unmocked fake-provider integration. There is no generated screenshot gallery or final-evidence suite. For a material visual change, inspect the affected desktop/mobile states in the running app and add a focused behavior test where practical.

## Task-Specific Checks

Add only checks justified by the changed boundary:

- Prisma/schema changes: create and commit a migration; run migrate deploy, seed smoke, integrity smoke, and migration-contract cases relevant to the migration.
- Installation bootstrap/image changes: run the focused bootstrap tests, build `runtime` plus `tools`, and prove fresh bootstrap plus adopted repeat against an explicitly named disposable Compose project. Because installation volumes and image tags have stable explicit names, every such smoke must also set unique temporary `AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, `AIQSA_APP_IMAGE`, and `AIQSA_TOOLS_IMAGE`; `-p` alone is not isolation. Prove an update preserves database rows and object bytes, then inspect that the app is non-root and contains no Prisma CLI/migrations.
- Backup/restore changes: run one real write-quiesced PostgreSQL/private-object backup and restore it only into explicitly disposable empty targets, then verify database and object bytes.
- Exposed proxy/deployment changes: validate Nginx before reload and directly smoke HTTPS redirect/TLS, liveness/readiness, login/session, upload storage, SMTP, CSP/browser console, and restart/rollback behavior appropriate to the change.
- Dependency changes: run `npm run security:deps` and review the lockfile/package lifecycle impact.
- Provider adapter changes: run deterministic adapter tests first; then the small explicit provider smoke only when permitted by `CRITICAL_INVARIANTS.md` and a key is present.
- Retention/schema changes: run `npm run db:retention:migration:contract`, use `npm run prune -- --dry-run`, and execute deletion only when intentional.

Do not turn these into a cumulative local release pipeline. Exposed-installation readiness is proved by the specific backlog tasks for migrations/bootstrap, backup/restore, hardening, security, observability, quotas, and load—not by rerunning unrelated harness machinery on every feature.

## Test Authoring

- Test observable behavior and stable contracts, not implementation shape.
- Add the cheapest deterministic regression test; add browser coverage only for a real cross-boundary risk.
- Prefer accessible roles and labels; use test ids only where semantics are insufficient.
- Use fake providers in automated tests. Never make paid external calls from Vitest or routine Playwright.
- Preserve explicit loading, error, empty, queued, streaming, cancelled, and terminal states when changing their owner.
- Keep fixtures small and avoid broad snapshots or duplicated governance assertions.
