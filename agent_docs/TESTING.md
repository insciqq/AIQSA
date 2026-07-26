# TESTING

## Verification Map

| Layer | Tool | What it proves | When it runs |
| --- | --- | --- | --- |
| Documentation and static checks | docs-check, ESLint, TypeScript | Living-doc contracts, code quality, and type safety | Routine `npm run check` |
| Server/API and UI behavior | Vitest and Testing Library | Business rules, handlers, permissions, adapters, stores, and components | Routine `npm run check` or a focused file set |
| Browser integration | Playwright | The browser/server boundary, routing, sessions, responsive interaction, and seeded persistence | Only for changes that cross those boundaries |
| Opt-in integration and smoke | Vitest and task-specific scripts | Prisma, MCP, ToolHive, migrations, installation, and real providers | Only when the changed boundary requires it |

The executable command definitions remain in `package.json`; `vitest.config.ts`, `playwright.config.ts`, and the test tree remain authoritative for runner details and actual coverage. Do not copy volatile test counts or exhaustive file inventories into this document.

Dedicated accessibility implementation and conformance are outside the current product scope and require a separately approved future task. Responsive layout, touch use, safe areas, software-keyboard clearance, readable content, and overflow remain ordinary product verification.

## Default Workflow

AIQSA has one routine application check. Start the isolated development stack, then run:

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec -T app npm run check
```

`check` generates the Prisma client, then runs compact documentation sanity, ESLint, TypeScript, and the application Vitest suite. Run it once near task completion, not after every edit.

While implementing, run only the smallest relevant test set:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run <test-files>
docker compose -f docker-compose.dev.yml exec -T app npm run lint
docker compose -f docker-compose.dev.yml exec -T app npm run typecheck
```

The default `docker-compose.yml` is an operator installation with persistent user data and is never the routine test target. A one-off `docker compose -f docker-compose.dev.yml run --rm app ...` is also valid, but it may start dependencies and is usually slower.

## Browser Integration

Run Playwright only when behavior crosses the browser/server boundary, routing, auth/session state, responsive input, or streaming integration:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npm run test:e2e
```

This is intentionally destructive verification inside the `aiqsa-dev` project. It may reset its database, replace seeded state, and write to its object bucket. Do not run E2E concurrently with development or another check. If it is interrupted, use `docker compose -f docker-compose.dev.yml down --remove-orphans`; use the same command with `-v` when a complete development-stack reset is acceptable. Neither command targets the default installation volumes.

The standalone Playwright web server inherits the runner's trimmed `AIQSA_ENCRYPTION_KEY`, with a deterministic test-only fallback when the variable is absent. Keep fixture encryption and the spawned server on that one value: provider, MCP, and SMTP envelopes are intentionally decrypted by the real runtime during browser tests. Reusable-server commands continue to use the key already present in the development app container.

The reset restores three public local logins: administrator `operator@aiqsa.local` / `AIQSA-local-2026!`, ordinary MCP member `mcp-member@aiqsa.local` / `AIQSA-mcp-member-2026!`, and ordinary restricted member `restricted-member@aiqsa.local` / `AIQSA-restricted-member-2026!`. Browser coverage signs in through the visible password form. These credentials exist only behind the development seed guard and are not safe for an exposed stack.

The retained Playwright specs cover registration, auth/session isolation, admin authorization, the critical conversation workspace, and local unmocked fake-provider integration. There is no generated screenshot gallery or final-evidence suite. For a material visual change, inspect the affected desktop/mobile states in the running app and add a focused behavior test where practical.

The two ordinary accounts deliberately exercise different MCP authority. Both receive Fake QSA and `Fixture Shared MCP` through the `dev-mcp-members` group; only MCP Member has the exact direct `workspace` personal-slot permission and a direct grant to `Fixture Private MCP`. Restricted Member has no direct MCP grants. `tests/e2e/non-admin-access.spec.ts` proves admin denial, group/direct catalog visibility, exact personal-slot writes, forbidden definition/grant/foreign-field mutations, enablement prerequisites, and ordinary model access against the real seeded routes. Run it on the reusable development server without resetting other local MCPs:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/non-admin-access.spec.ts --project=chromium
```

The shell browser fixture also proves that persisted tool activity is visible by default and that hide/show survives reload without changing the run. Reuse the existing server so local MCP state is preserved:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/shell.spec.ts --project=chromium \
  --grep "shows tool activity by default and persists hide/show across reload"
```

## Task-Specific Checks

Add only checks justified by the changed boundary:

- Prisma/schema changes: create and commit a migration; run migrate deploy, seed smoke, integrity smoke, and migration-contract cases relevant to the migration.
- Installation bootstrap/image changes: run the focused bootstrap tests, build `runtime` plus `tools`, and prove fresh bootstrap plus adopted repeat against an explicitly named disposable Compose project. Because installation volumes and image tags have stable explicit names, every such smoke must also set unique temporary `AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, `AIQSA_APP_IMAGE`, and `AIQSA_TOOLS_IMAGE`; `-p` alone is not isolation. Prove an update preserves database rows and object bytes, then inspect that the app is non-root and contains no Prisma CLI/migrations.
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

For focused MCP catalog, remote policy/runtime, OAuth, local lifecycle, run-plan, and cleanup verification, use:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/mcp/handlers.test.ts \
  lib/server/mcp/clientSession.test.ts \
  lib/server/mcp/safeFetch.test.ts \
  lib/server/mcp/remoteDraftValidator.test.ts \
  lib/server/mcp/localPackageResolver.test.ts \
  lib/server/mcp/localDraftValidator.test.ts \
  lib/server/mcp/toolhiveClient.test.ts \
  lib/server/mcp/toolhiveRuntimeDriver.test.ts \
  lib/server/mcp/toolhiveSessionFactory.test.ts \
  lib/server/mcp/toolhiveCleanupCli.test.ts \
  lib/server/mcp/oauthService.test.ts \
  lib/server/mcp/oauthRepository.test.ts \
  lib/server/mcp/oauthHandlers.test.ts \
  lib/server/mcp/oauthSettlement.test.ts \
  lib/server/mcp/runtimeCoordinator.test.ts \
  lib/server/mcp/runtimeRepository.test.ts \
  lib/server/mcp/runPlan.test.ts \
  lib/server/mcp/runPlanRepository.test.ts \
  lib/server/runs/mcpRunBindings.test.ts \
  lib/server/runs/toolInspection.test.ts
```

The local protocol integration starts an in-process official-SDK Streamable HTTP fixture and makes no external or paid call. OAuth unit/handler suites likewise use deterministic discovery/token fixtures; they do not authorize a real Notion workspace:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/mcp/remoteRuntime.integration.test.ts
```

The Prisma MCP repository integration uses unique rows and cleans them from the disposable development database. It is opt-in so ordinary unit runs do not require Postgres:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_MCP_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/mcp/prismaRepository.integration.test.ts
```

The real ToolHive OCI stdio smoke is opt-in because it controls sibling Docker resources and may pull an image. Run it only against the disposable development ToolHive service, never the persistent installation:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_TOOLHIVE_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/mcp/toolhive.integration.test.ts
```

The test uses a random exact ownership group and cleans it after the run. Its default fixture is a digest-pinned public OCI image; `AIQSA_TOOLHIVE_OCI_SMOKE_IMAGE` may select another reviewed digest-pinned fixture. Npm/PyPI materialization smokes may contact their registries and are task-specific rather than routine. A hosted Notion consent/token/tool-call smoke requires an explicitly authorized test workspace and is not part of automated verification; public metadata discovery alone must not be reported as end-to-end success.

For the provider-neutral durable tool loop, run the generic loop/persistence suites together with live/recovery and provider wire adapters:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/runs/toolLoop.test.ts \
  lib/server/runs/toolLoopPersistence.test.ts \
  lib/server/runs/toolExecutionPersistence.test.ts \
  lib/server/runs/providerToolLoop.test.ts \
  lib/server/runs/runExecution.test.ts \
  lib/server/runs/runRecovery.test.ts \
  lib/server/providers/openaiResponsesRequest.test.ts \
  lib/server/providers/openRouterChatResponse.test.ts \
  lib/server/providers/anthropicMessages.test.ts
```

For ADR 0022 provider control-plane, stable-ID admission/runtime, and Admin UI behavior, use the deterministic focused suites below. They use encrypted fixture keys and fake fetches; they make no paid provider call:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/admin/providers \
  lib/server/providerRuntime \
  lib/server/providers/providerConfiguration.test.ts \
  lib/server/providers/providerSafeFetch.test.ts \
  lib/server/providers/runtimeFactory.test.ts \
  app/api/admin/providers \
  components/admin/AdminSearchablePicker.test.tsx \
  components/admin/AdminProvidersSection.test.tsx \
  components/admin/adminProvidersApi.test.ts \
  components/admin/providerUiState.test.ts \
  components/admin/useAdminOpenRouterDiscovery.test.tsx
```

For ADR 0024 fixed run-profile persistence, catalog projection, administration, and composer behavior, use:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/admin/runProfiles \
  lib/server/catalog/handlers.test.ts \
  lib/server/catalog/prismaCatalogData.test.ts \
  lib/contracts/catalog.test.ts \
  components/admin/AdminRunProfilesPanel.test.tsx \
  components/admin/adminRunProfilesApi.test.ts \
  components/app-shell/ComposerControls.test.tsx \
  components/app-shell/MainThreadPane.test.tsx \
  components/app-shell/controlDefaults.test.tsx
```

For ADR 0030 direct Model/Profile/Search disclosure and the compact completed-answer search/citation receipt, use:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  components/app-shell/ComposerControls.test.tsx \
  components/app-shell/ThreadMessageRow.test.tsx \
  components/app-shell/runReceipt.test.ts \
  components/chat/Composer.test.tsx
```

The composer case must prove Model and Search open their real pickers directly, configured profiles apply in one click, More retains the complete setup and one state owner, and compact wrapping has no page overflow. The answer case must prove terminal receipt plus search/citation facts share one block, details toggle inside it, and historical evidence never borrows current composer defaults.

For ADR 0023 runtime SMTP configuration and delivery semantics, use:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/email \
  app/api/admin/email \
  components/admin/AdminEmailSection.test.tsx \
  components/admin/adminEmailApi.test.ts
```

For the ADR 0026/0028/0030/0031/0032 reviewed Quick setup, native Gemini, Custom compatible setup, direct-user persistence, route/repository contracts, grounding UI, and runtime state, use:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/admin/providers/quickSetupPolicy.test.ts \
  lib/server/admin/providers/quickSetupService.test.ts \
  lib/server/admin/providers/quickSetupHandlers.test.ts \
  lib/server/admin/providers/quickSetupPrismaRepository.test.ts \
  lib/server/admin/providers/credentialTester.test.ts \
  lib/server/admin/providers/customSetupHandlers.test.ts \
  lib/server/admin/providers/customSetupService.test.ts \
  lib/server/admin/providers/customSetupPrismaRepository.test.ts \
  lib/server/admin/providers/service.test.ts \
  lib/server/providers/geminiInteractionsGrounding.test.ts \
  lib/server/providers/geminiInteractionsRequest.test.ts \
  lib/server/providers/geminiInteractionsResponse.test.ts \
  lib/server/providers/geminiInteractionsTransport.test.ts \
  lib/server/providers/openaiCompatibleChatResponse.test.ts \
  lib/server/providers/runtimeFactory.test.ts \
  lib/server/runs/groundingPersistence.test.ts \
  lib/server/tools/bridges.test.ts \
  components/admin/adminProviderCustomSetupApi.test.ts \
  components/admin/adminProviderQuickSetupApi.test.ts \
  components/admin/useAdminProviderQuickSetupController.test.tsx \
  components/app-shell/GeminiSearchSuggestions.test.tsx \
  components/admin/AdminProvidersExperience.test.tsx
```

That focused set must cover policy-v3 OpenAI/Anthropic/Gemini/OpenRouter candidate ordering, normalized Gemini `models/` ids, rejection of arbitrary remote rows, atomic checks/grants for every remotely visible reviewed candidate, replacement preservation for every currently available entitled canonical model, the 64-model Quick bound, no-write behavior when a catalog loses one required upstream id, and actor-only assignment clearing through DELETE. Gemini coverage must prove native-only admission/runtime, native terminal proof, exact function/thought continuation, no Search-plus-client-tools, strict Suggestions validation, marker/display/token order, ordinary no-search completion, live-only complete/fail cleanup, context placeholder, and share rejection. Custom coverage must prove safe endpoint/auth validation, one pre-transaction test, atomic direct assignment/grant/default behavior, real null no-auth evidence, and bearer/no-auth runtime headers. Clearing must prove that the credential/version, checks, grants, defaults, and team configuration are retained.

For the atomic native cutover and no-auth version constraint, run the disposable PostgreSQL contract:

```bash
npm run db:gemini:migration:contract
```

It applies every pre-target migration to isolated databases, proves empty/existing conversion, unchanged credentials/envelopes/assignments/grants/defaults/checks and execution snapshots, old active compatible-run settlement, native/terminal-run preservation, grounding/search constraints, explicit no-auth evidence, and full rollback for unknown Gemini roots/adapters.

The repository also has opt-in Prisma integration cases. The suite creates and drops temporary schemas so saved development runs, credentials, custom connections, and `ProviderRunBinding` rows cannot affect or be affected by Quick setup reset/rollback cases; scenarios that need independently committed or concurrent state receive their own additional isolated schema. Run them only against the disposable development stack:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_PROVIDER_QUICK_SETUP_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/admin/providers/quickSetupPrismaRepository.integration.test.ts
```

For ADR 0029 built-in `Full access`, run the pure entitlement/admission, bootstrap/admin, MCP, and presentation coverage plus the disposable migration contract:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run \
  lib/server/auth/entitlements.test.ts \
  lib/server/auth/dbEntitlements.test.ts \
  lib/server/auth/fullAccessGroup.test.ts \
  lib/server/auth/adminDashboardQueries.test.ts \
  lib/server/auth/adminRepository.test.ts \
  lib/server/auth/adminDeletionMetadata.test.ts \
  lib/server/auth/adminRepositorySerializers.test.ts \
  lib/server/admin/providers/quickSetupPrismaRepository.test.ts \
  lib/server/catalog/prismaCatalogData.test.ts \
  lib/server/providerRuntime/admission.test.ts \
  lib/server/bootstrap/installationBootstrap.test.ts \
  lib/server/mcp/handlers.test.ts \
  components/admin/AdminAccessGroupsSection.test.tsx \
  components/admin/AdminMcpGrantPanels.test.tsx
npm run db:full-access:migration:contract
```

The contract covers an empty migrated database that remains available for first bootstrap, isolation and lossless collision-safe renaming of every legacy reserved-name group, earliest-existing-admin membership, group/grant-id collision handling, current/future MCP grants, rejection of archived/system-lifecycle mutation, ordinary-group deletion, and database identity/lifecycle protection. Repository integration remains authoritative for the generated MCP grant's mutation refusal and cascade behavior. The provider cases must prove that wildcard entitlement reaches catalog/Quick preservation and atomic admission without materialized provider grants, while credential selection still follows its independent direct/group/default fail-closed policy.

The stopped control-plane migration has four deterministic contracts. They create only temporary databases or in-memory fixtures and do not contact providers or SMTP:

```bash
npm run db:control-plane:migration:contract
npx tsx prisma/scripts/tests/provider-control-plane-migration-contract.ts
npx tsx prisma/scripts/tests/smtp-control-migration-contract.ts
npx tsx prisma/scripts/tests/mcp-envelope-v2-cutover-contract.ts
```

The Admin provider/run-profile, email, and MCP browser boundaries can reuse the disposable development server:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test \
    tests/e2e/provider-admin-ui.spec.ts \
    tests/e2e/admin-email-ui.spec.ts \
    tests/e2e/admin-mcp-ui.spec.ts \
    --project=chromium
```

Those specs mock only each Admin resource boundary for the administrator workflow. The provider browser case mocks the Quick and Custom task endpoints for their actor-relative UI state machines; after Quick Ready it installs a disposable persisted graph and uses the real current-user catalog, chat/message routes, OpenAI Responses SSE runtime, saved answer, ModelRun API, and exact ProviderRunBinding before restoring the prior user defaults and removing every fixture row. The separate Custom journey verifies the Endpoint -> Model ID -> API key -> Test & Save request and Ready receipt at wide and compact viewports; the local transport smoke and repository/service tests own its actual compatible request and atomic persistence. The same spec proves the persistent Setup/Connections/Run profiles task line, their lazy resource boundaries, policy-v3 picker resubmission, retry/reconciliation, multi-model Ready receipt, replacement preservation, confirmation-gated actor-assignment removal, the two-column compact/four-column wide provider grid, first-screen key/action placement, contextual/exact Connections handoff with index/detail Back, explicit model Enabled -> Disable -> Disabled -> Enable lifecycle, automatic loading of a large account catalog into the sorted/searchable OpenRouter picker, capability/provider search, automatic endpoint loading after explicit manual-routing selection, ordered route tags, collapsed optional diagnostics, contextual activation, and one atomic three-slot run-profile save. Its ordinary-user case exercises the real Quick, Custom, provider, and run-profile `403` routes; repository, service, route, transport, and runtime tests remain authoritative for RBAC, write-only secret handling, atomic direct-user initial/recovery/replacement persistence, profile constraints, catalog visibility, discovery-cache races, direct/group/default credential selection, revocation, SSRF/TLS rules, and delivery outcomes.

`tests/e2e/auth-admin.spec.ts` uses the real admin action route and Prisma state for Users and Access & groups. Its group-detail membership case adds and removes a member from the local Members task, proves unrelated active and archived memberships survive the complete replacement payload, verifies archived groups expose no mutation controls, and checks that Back preserves the group-directory query. The same real-data boundary verifies that `Full access` is visible as built-in, contains the seeded first administrator, leaves Members editable, and exposes no rename/archive/delete or per-resource grant controls.

MCP UI behavior has focused component/API/store coverage in `components/app-shell/*Mcp*.test.tsx`, `components/app-shell/mcpSettings*.test.ts`, and `components/admin/AdminMcp*.test.tsx`. Its deterministic browser boundary is:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npx playwright test tests/e2e/mcp-ui.spec.ts --project=chromium
```

That standalone Playwright command intentionally runs the configured `prisma migrate reset` against the disposable development database before starting its test server. Do not use it when interactive development fixtures must survive. If the existing `docker-compose.dev.yml` app is already running with its normal local test-auth configuration, preserve its database and reuse that server instead:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test tests/e2e/mcp-ui.spec.ts --project=chromium
```

That spec mocks only the MCP catalog/mutation boundary while exercising Settings routing, separate availability status and lifecycle actions, multi-enable state, write-only fields, OAuth-return auto-enable state and query scrubbing, the visible composer availability aggregate plus detailed title, and compact containment. Repository/route tests remain authoritative for server grants, secrets, OAuth settlement, and runtime state.

Do not turn these into a cumulative local release pipeline. Exposed-installation readiness is proved by the specific backlog tasks for migrations/bootstrap, backup/restore, hardening, security, observability, quotas, and load—not by rerunning unrelated harness machinery on every feature.

## Test Authoring

- Test observable behavior and stable contracts, not implementation shape.
- Add the cheapest deterministic regression test; add browser coverage only for a real cross-boundary risk.
- Focused `.only` tests are forbidden in both Vitest and Playwright configuration; use an explicit focused command while iterating.
- Prefer stable visible roles and labels when they already describe product behavior; use test ids where they are clearer or more durable.
- Use fake providers in automated tests. Never make paid external calls from Vitest or routine Playwright.
- Preserve explicit loading, error, empty, queued, streaming, cancelled, and terminal states when changing their owner.
- Keep fixtures small and avoid broad snapshots or duplicated governance assertions.
