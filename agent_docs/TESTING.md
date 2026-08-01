# TESTING

Owner: Verification harness maintainers
Scope: Current hermetic, container-parity, browser, migration, integration, provider-smoke, and test-authoring workflows and isolation rules.
Verified against: 4f51fdd (2026-08-01)

## Verification Map

| Layer | Tool | What it proves | When it runs |
| --- | --- | --- | --- |
| Hermetic host checks | generated-doc drift, docs-check, ESLint, TypeScript, Vitest/Testing Library | Living contracts, code quality, types, and deterministic behavior without a database, Docker, network, or secrets | Focused iteration and `npm run check:hermetic` before completion of bounded static/unit work |
| Container parity | disposable Compose plus the complete `npm run check` | The same checks with PostgreSQL-backed repository/concurrency cases and release-like Node/container dependencies | When the change touches server/database/container boundaries or before broader integration/release evidence |
| Browser integration | Playwright | The browser/server boundary, routing, sessions, responsive interaction, and seeded persistence | Only for changes that cross those boundaries |
| Opt-in integration and smoke | Vitest and task-specific scripts | Prisma, MCP, ToolHive, migrations, installation, and real providers | Only when the changed boundary requires it |

The executable command definitions remain in `package.json`; `vitest.config.ts`, `playwright.config.ts`, and the test tree remain authoritative for runner details and actual coverage. Do not copy volatile test counts or exhaustive file inventories into this document.

Accessibility scope is owned by `FRONTEND.md`. Responsive layout, touch use, safe areas, software-keyboard clearance, readable content, and overflow remain ordinary product verification.

## Verification Lanes

Bootstrap a clean checkout with the lockfile-owned install, then use the host-local hermetic lane:

```bash
npm ci
npm run check:hermetic
```

`check:hermetic` generates the Prisma client without connecting to a database, verifies the generated API/schema reference and living docs, runs ESLint and TypeScript, then runs every deterministic Vitest/Testing Library case through `vitest.hermetic.config.ts`. Direct Prisma-singleton tests are an explicit reviewed list, and all `*.integration.test.*` files remain outside this lane; `tests/harness/hermetic-vitest-config.test.ts` fails when a new direct database test is not classified. The lane requires no Docker, `DATABASE_URL`, provider key, registry, or external service.

During implementation, keep feedback narrower:

```bash
npx vitest run --config vitest.hermetic.config.ts <test-files>
npx eslint <changed-paths>
npx tsc --noEmit
```

Run the complete disposable container-parity lane when the changed behavior needs PostgreSQL, process/container topology, migrations, server/browser integration, or another service boundary:

```bash
docker compose -f docker-compose.dev.yml up -d
npm run check:container
```

`check:container` is a host wrapper for `docker compose -f docker-compose.dev.yml exec -T app npm run check`. The inner `check` runs generated-doc/docs drift, lint, TypeScript, the complete Vitest suite, and PostgreSQL-backed repository/concurrency cases. A small documentation, pure-domain, component-unit, or deterministic adapter change may finish on the hermetic lane when its acceptance criteria do not cross a container boundary; Compose is not mandatory merely because application code changed.

The default `docker-compose.yml` is an operator installation with persistent user data and is never a development test target. A one-off `docker compose -f docker-compose.dev.yml run --rm app ...` is valid only against the disposable development topology and only when the selected check needs its dependencies.

## Browser Integration

Run Playwright only when behavior crosses the browser/server boundary, routing, auth/session state, responsive input, or streaming integration:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npm run test:e2e
```

This is intentionally destructive verification inside the `aiqsa-dev` project. It may reset its database, replace seeded state, and write to its object bucket. Do not run E2E concurrently with development or another check. If it is interrupted, use `docker compose -f docker-compose.dev.yml down --remove-orphans`; use the same command with `-v` when a complete development-stack reset is acceptable. Neither command targets the default installation volumes.

The standalone Playwright web server inherits the runner's trimmed `AIQSA_ENCRYPTION_KEY`, with a deterministic test-only fallback when the variable is absent. Keep fixture encryption and the spawned server on that one value: provider, MCP, and SMTP envelopes are intentionally decrypted by the real runtime during browser tests. Reusable-server commands continue to use the key and fake-provider token delay already present in the development app container; recreate `app` after changing either value. The standard nonzero fake-provider delay keeps streaming and cancellation observable in reusable-server coverage.

The reset restores three public local logins: administrator `operator@aiqsa.local` / `AIQSA-local-2026!`, ordinary MCP member `mcp-member@aiqsa.local` / `AIQSA-mcp-member-2026!`, and ordinary restricted member `restricted-member@aiqsa.local` / `AIQSA-restricted-member-2026!`. Browser coverage signs in through the visible password form. These credentials exist only behind the development seed guard and are not safe for an exposed stack.

Playwright covers only cross-boundary product risks: auth/session isolation, admin authorization, the conversation workspace, standalone Prompt library versus bounded Settings, responsive transitions, and local unmocked fake-provider integration. Prompt-library checks include the 1024px-by-greater-than-512px split boundary, one-task compact navigation, local scrolling, guarded transitions, and nested confirmation ownership. Exercise normal desktop and phone sizes plus 1024x512 and one wide-short viewport. There is no generated screenshot gallery or final-evidence suite; inspect material visual changes directly in the running app.

The two ordinary accounts deliberately exercise different MCP authority. Both receive Fake QSA and `Fixture Shared MCP` through the `dev-mcp-members` group; only MCP Member has the exact direct `workspace` personal-slot permission and a direct grant to `Fixture Private MCP`. Restricted Member has no direct MCP grants. `tests/e2e/non-admin-access.spec.ts` proves admin denial, group/direct catalog visibility, exact personal-slot writes, forbidden definition/grant/foreign-field mutations, enablement prerequisites, and ordinary model access against the real seeded routes. Run it on the reusable development server without resetting other local MCPs:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/non-admin-access.spec.ts --project=chromium
```

The shell browser fixture also proves that persisted tool activity is visible by default, hide/show survives reload without changing the run, and a client Search tool expands through engine execution to bounded provider-reported operations/queries without duplicate Search chrome or compact overflow. Reuse the existing server so local MCP state is preserved:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/shell.spec.ts --project=chromium \
  --grep "shows tool activity by default and persists hide/show across reload"
```

Use the adjacent focused title `expands a Search tool into engine and provider-operation detail` for the nested Search receipt slice. The passive update notice has its own mocked-GitHub browser boundary:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/admin-release-update.spec.ts --project=chromium
```

Routine Playwright never contacts GitHub. Release-reader cache/ETag/failure behavior is deterministic Vitest coverage; the browser spec intercepts only the bounded AIQSA admin response.

## Task-Specific Checks

Add only checks justified by the changed boundary:

- Prisma/schema changes: create and commit a migration; run migrate deploy, seed smoke, integrity smoke, and migration-contract cases relevant to the migration.
- Installation bootstrap/image changes: run the focused bootstrap tests, build the single `release` target, and prove fresh bootstrap plus adopted repeat against an explicitly named disposable Compose project. Because installation volumes and image tags have stable explicit names, every such smoke must also set unique temporary `AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, `AIQSA_TOOLHIVE_VOLUME_NAME`, and `AIQSA_IMAGE`; `-p` alone is not isolation. Prove an update preserves database rows and object bytes, then inspect that the image is non-root and its app, migration/bootstrap, and maintenance commands all work.
- First-install env-helper changes: run `bash -n prepare-secrets.sh` and `npx vitest run tests/harness/prepare-secrets.test.ts` inside the development app container. Tests must use temporary targets and never invoke the helper against the repository's real `.env`.
- Backup/restore changes: run one real write-quiesced PostgreSQL/private-object backup and restore it only into explicitly disposable empty targets, then verify database and object bytes.
- Exposed proxy/deployment changes: validate Nginx before reload and directly smoke HTTPS redirect/TLS, liveness/readiness, login/session, upload storage, SMTP, CSP/browser console, and restart/rollback behavior appropriate to the change.
- Dependency changes: run `npm run security:deps` and review the lockfile/package lifecycle impact.
- Provider adapter changes: run deterministic adapter tests first; then the small explicit provider smoke only when permitted by `CRITICAL_INVARIANTS.md` and a key is present.
- Retention/schema changes: run `npm run db:retention:migration:contract`, use `npm run prune -- --dry-run`, and execute deletion only when intentional.

For the first-class native Gemini Interactions boundary, the optional real-key smoke is:

```bash
npm run smoke:gemini
```

It reads `GEMINI_API_KEY` and optional `AIQSA_GEMINI_SMOKE_MODEL` only for that process, uses the native v1 runtime with `store: false`, and verifies bounded SSE completion, one function call/continuation with private thought-signature replay, plus a native Google Search result whose Suggestions precede answer tokens. Output is restricted to booleans/counts and sanitized step/usage evidence; it must not print the key, response text, Suggestions markup, citation Links, raw provider payload, or signature. A missing key skips cleanly.

The Custom compatible path has a deterministic no-network smoke:

```bash
npm run smoke:custom-openai-compatible
```

It starts an in-process loopback Chat Completions fixture and proves manual model routing, bearer auth, explicit no-auth without an `Authorization` header, two streamed text deltas, terminal proof, and usage. It does not read a provider key or call an external service.

### Opt-in integration boundaries

Choose focused unit and component files from the current test tree; do not maintain a historical decision-by-decision file list here. The following commands are documented because they cross a special process, database, Docker, or external-service boundary.

The MCP protocol fixture is local and credential-free. Prisma and ToolHive coverage are explicit opt-ins against the disposable development stack:

```bash
docker compose -f docker-compose.dev.yml exec -T app \
  npx vitest run lib/server/mcp/oauthService.test.ts
docker compose -f docker-compose.dev.yml exec -T app \
  npx vitest run lib/server/mcp/remoteRuntime.integration.test.ts
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_MCP_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/mcp/prismaRepository.integration.test.ts
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_TOOLHIVE_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/mcp/toolhive.integration.test.ts
```

`oauthService.test.ts` includes the provider-neutral brokered-OAuth regression:
one reusable MCP client registration, two isolated users, distinct upstream and
MCP token families, exact resource/client/callback/S256 binding, one bounded
read call, refresh rotation, revocation, disconnect, and reconnect. It uses no
Tracker code, package, service, credential, or provider-name branch.

Same-origin MCP resource autobinding additionally requires `oauthPolicy` and
service/repository cases for origin-root/path resources, explicit-policy
compatibility, malformed/cross-origin rejection, callback rebinding, and stable
fingerprints. Route/component coverage proves browser Connect/Reconnect use
authenticated GET navigation while compatibility POST remains available.

Compatible-provider discovery changes require credential/API decoder tests for
the bounded capability allowlist and secret non-reflection, configuration and
catalog tests for reasoning options/defaults, and component/controller tests
for reported metadata, the disclosed GPT-5.6 Sol fallback, explicit disable,
and Responses hosted search. A real gateway remains an opt-in sanitized smoke,
never routine Vitest input.

Compatible reasoning-mapping changes additionally require exact Chat and
Responses request-body tests for protocol defaults, safe overrides, and
`standard | pro`; invalid/reserved/prototype/colliding-path tests; immutable
snapshot/runtime and redacted-preview parity; catalog mode projection; and
Custom-setup plus saved-model-editor coverage. Production Fake withdrawal must
run the provider-control-plane migration contract and prove installation
bootstrap disables existing code-owned Fake publication without deleting
historical bindings while the disposable dev seed remains runnable. Context
gauge changes require derivation/component tests plus viewport and horizontal-
overflow assertions at 384x844, 844x390, and 768x1024.

Overlay geometry cases normally inherit deterministic `data-motion=off`, but a
case that protects positioning from entrance-animation properties must remove
that attribute before opening the surface. The wide-screen Run setup case does
so and waits for the actual `pop-enter` animation before asserting viewport
bounds and local overflow.

The ToolHive case controls sibling Docker resources and may pull the reviewed digest-pinned fixture. Package-registry materialization, hosted Notion consent/tool-call checks, and a brokered-SaaS live consent require the corresponding external authority; metadata discovery alone is not end-to-end verification. Live broker evidence must be sanitized and may report stable booleans/counts only; it must not print OAuth material, account email, organization identity, task text, comments, or raw upstream responses.

MCP installation-activation changes require focused coordinator/repository tests
for enqueue idempotency, claim/heartbeat/reclaim, draft and shared-version
fencing, stage projection, workload retention, and atomic publication. A schema
change also requires the ordinary migration deployment, seed/integrity smoke,
and migration contract. Keep real package pulls or hosted OAuth consent opt-in;
unit tests use deferred validators and disposable repository fixtures.

Quick-setup repository integration creates isolated schemas and is also opt-in:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_PROVIDER_QUICK_SETUP_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/admin/providers/quickSetupPrismaRepository.integration.test.ts
```

Migration contracts operate only on temporary databases or in-memory fixtures. Select the script owned by the changed migration; current entry points include:

```bash
npm run db:auth-rate-limit:migration:contract
npm run db:gemini:migration:contract
npm run db:provider:migration:contract
npm run db:full-access:migration:contract
npm run db:control-plane:migration:contract
npm run db:retention:migration:contract
npm run db:search:migration:contract
```

Durable authentication admission additionally has an opt-in two-client PostgreSQL concurrency/restart case:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_AUTH_RATE_LIMIT_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/auth/prismaRateLimit.integration.test.ts
```

The Search control-plane migration contract starts from the legacy single-engine schema and proves singleton defaults, grants, accepted provider bindings, and historical Search runs survive while every concrete option gains an active revision and new multi-binding constraints admit several technical engines. It then applies the inherited-preference migration and proves existing non-null plans remain personal, the installation policy starts versioned at Off, `defaultSearchPlan` becomes nullable with no SQL default, and a newly inserted settings row inherits through null. Search changes additionally require deterministic preferred/effective plan and combination coverage, version-fenced admin policy/lifecycle tests, catalog/settings/admission, strict query-only adapter and redacted-preview tests, zero-call malformed/empty/extra/oversized argument cases, attachment/client-Search incompatibility across preparation/live/recovery, provider-hosted attachment parity, fan-out/recovery, accepted-run preference persistence, composer, and Control Center tests. Provider-operation changes additionally prove lifecycle merge/bounds, safe tool-result plus durable-call projection, malformed contract rejection, historical-unavailable behavior, and non-duplicated nested browser disclosure. Provider-model role changes must prove legacy answer defaults, technical-only exclusion from every answer/grant/profile projection and direct admission, plus continued technical Search listing and admission without an answer-model grant. Browser coverage proves organization/personal/Off behavior, retained unavailable engines across model switches/reload, direct wide/tall versus More-only short Reasoning, the real Search destination, nested Search trace, and viewport-bounded Run setup. Real gateway proof remains one explicit sanitized operator-authorized smoke, never routine Vitest or Playwright input.

Browser slices may reuse the running disposable app without resetting local fixtures:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test <spec-files> --project=chromium
```

Use the standalone `run --rm` Playwright form only when the selected spec requires its configured reset and losing interactive development fixtures is acceptable. The test tree and Playwright configuration own the available spec names and their fixtures.

When a reusable-server slice needs an expired/revoked session, it must update only the exact browser session created by that case and record an explicit test reason. Do not invoke a user-wide admin revoke or disable against the seeded operator: the development stack can contain other live operator sessions even though its data is disposable.

These opt-ins are not a cumulative release pipeline. Exposed-installation readiness is proved by the specific migration, bootstrap, backup/restore, hardening, security, observability, quota, and load work that changed—not by rerunning unrelated integrations for every feature.

## Test Authoring

- Test observable behavior and stable contracts, not implementation shape.
- Add the cheapest deterministic regression test; add browser coverage only for a real cross-boundary risk.
- Focused `.only` tests are forbidden in both Vitest and Playwright configuration; use an explicit focused command while iterating.
- Prefer stable visible roles and labels when they already describe product behavior; use test ids where they are clearer or more durable.
- Use fake providers in automated tests. Never make paid external calls from Vitest or routine Playwright.
- Preserve explicit loading, error, empty, queued, streaming, cancelled, and terminal states when changing their owner.
- Keep fixtures small and avoid broad snapshots or duplicated governance assertions.
