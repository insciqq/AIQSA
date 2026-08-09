# TESTING

Owner: Verification harness maintainers
Scope: Stable verification routing, disposable-environment rules, non-obvious opt-in entry points, and general test-authoring contracts.

## Verification Map

| Layer | Tool | What it proves | When it runs |
| --- | --- | --- | --- |
| Focused hermetic | ESLint, TypeScript, Vitest, Testing Library, generated-doc and docs drift checks | The smallest deterministic regression and affected static contracts without a database, Docker, network, or secrets | During implementation |
| Hermetic completion | `npm run check:hermetic` | All deterministic host-local code, type, documentation, and unit/component contracts | Before completion of bounded static, pure-domain, adapter, or component work |
| Container parity | disposable `docker-compose.dev.yml` plus `npm run check:container` | PostgreSQL-backed repository/concurrency behavior and release-like Node/container dependencies | When a change crosses database, process, container, or integration boundaries |
| Browser integration | Playwright against the disposable development stack | Browser/server routing, sessions, responsive interaction, streaming, and seeded persistence | Only for a real browser or cross-boundary product risk |
| Opt-in boundary evidence | Focused scripts and integration tests | Migrations, installation, MCP/ToolHive, auth concurrency, security, and real-provider behavior | Only when the changed boundary requires it |

Executable scripts in `package.json`, runner configuration, and the current test tree own exact code coverage and discoverable test names. Do not maintain volatile counts, exhaustive file inventories, exact test-title instructions, or feature-by-feature regression histories here. Accessibility and responsive product scope are routed by `FRONTEND.md`; provider, auth, persistence, and security assertions live in their subject owners.

`scripts/docs-manifest.mjs` is the sole executable inventory of mandatory
documentation. The documentation checker also rejects a substantial normalized
prose or list-item block copied between bounded normative living owners. It
excludes routing indexes, metadata, headings, code fences, generated output,
and task state; similarity remains a human audit input rather than an automated
rewrite signal. Cross-layer ownership follows `DECISION_DEFAULTS.md`: tests may
enforce the absence of a copied block, but only contract review can decide
whether differently worded statements own the same proposition.

## Core Verification Lanes

### Focused and hermetic

Bootstrap a clean checkout from the lockfile, then use the host-local lane:

```bash
npm ci
npm run check:hermetic
```

`check:hermetic` generates the Prisma client without connecting to a database, runs documentation/reference drift checks, ESLint, TypeScript, and every deterministic Vitest/Testing Library case through `vitest.hermetic.config.ts`. Direct Prisma-singleton tests are a reviewed explicit list; `*.integration.test.*` files stay outside this lane, and the harness test rejects an unclassified direct database test. The lane requires no Docker, `DATABASE_URL`, provider key, registry, or external service.

Keep iteration narrower when possible:

```bash
npx vitest run --config vitest.hermetic.config.ts <test-files>
npx eslint <changed-paths>
npx tsc --noEmit
```

Choose the cheapest command that proves the current increment, then run the proportional completion lane. Documentation-only work runs `npm run docs:check`; generated-reference work also runs `node scripts/generate-doc-reference.mjs --check`.

### Container parity

Use the disposable development topology when behavior needs PostgreSQL, process/container topology, migrations, or another service boundary:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
```

`check:container` executes the complete `npm run check` inside the development app container, including PostgreSQL-backed repository/concurrency cases. A small documentation, pure-domain, component-unit, or deterministic adapter change does not require Compose merely because it changes application code.

The default `docker-compose.yml` is the persistent operator installation and is never a development or test target. One-off commands are valid only against `docker-compose.dev.yml`. Development data is disposable, but stateful/container checks are not safe to run concurrently.

## Browser Integration

Run Playwright only when behavior crosses the browser/server boundary, routing, auth/session state, responsive input, or streaming integration:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npm run test:e2e
```

This lane may reset the `aiqsa-dev` database, replace seeded state, and write to its object bucket. Do not run it concurrently with development or another stateful check. After interruption, clean only the disposable topology with:

```bash
docker compose -f docker-compose.dev.yml down --remove-orphans
```

Add `-v` only when deleting the complete development-stack state is intentional. Neither form may target the default installation volumes.

Focused browser slices may reuse an already running disposable app when their fixtures do not require reset:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e PLAYWRIGHT_REUSE_SERVER=1 app \
  npx playwright test <spec-files> --project=chromium
```

Use the standalone `run --rm` form when the selected spec requires the configured reset and loss of interactive development fixtures is acceptable. Inspect material visual changes directly at the viewport, input, theme, zoom, and motion conditions owned by the frontend contract; there is no generated screenshot-gallery or final-evidence ceremony. Local auth fixtures and session-mutation safety are owned by the bounded security contracts routed by `SECURITY.md`.

## Test Authoring

- Test observable behavior and stable contracts, not implementation shape.
- Add the cheapest deterministic regression test; add browser, database, container, or real-service coverage only for a genuine boundary risk.
- Focused `.only` tests are forbidden in Vitest and Playwright configuration; focus with the command line while iterating.
- Prefer stable visible roles and labels when they describe product behavior; use test ids where they are clearer or more durable.
- Use fake providers in automated tests. Vitest and routine Playwright never make paid external calls.
- Preserve explicit loading, error, empty, queued, streaming, cancelled, and terminal states when changing their owner.
- Keep fixtures small and isolated; avoid broad snapshots, duplicated governance assertions, or dependence on execution order.
- Database/integration tests must default to a clean skip unless their explicit disposable dependency and opt-in gate are present. Create isolated schemas/resources where supported and clean only what the test owns.
- Migration, backup, prune, browser-reset, and installation tests must validate their exact disposable target before mutation.
- Sanitize external evidence to stable booleans, counts, codes, and bounded metadata. Never emit secrets, private content, raw upstream responses, or provider-rendered answer text merely to prove a smoke passed.

## Boundary-Specific Evidence

Add only evidence justified by the changed boundary:

| Changed boundary | Proportional evidence |
| --- | --- |
| Prisma schema or migration | Commit an append-only migration; run deploy, seed/integrity smoke, and the focused migration contract against an explicitly disposable database. Never use a persistent installation as a migration test target. |
| Installation bootstrap, image, or Compose topology | Run focused bootstrap/config tests, build the single `release` target, and prove fresh bootstrap plus adopted repeat in a uniquely named disposable project. Stable volume/image names require unique temporary `AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, `AIQSA_TOOLHIVE_VOLUME_NAME`, and `AIQSA_IMAGE`; `-p` alone is not isolation. Prove update preservation and the required non-root runtime roles when those behaviors changed. |
| First-install helper | Run shell syntax plus its focused harness test against temporary files; never invoke it against the repository's real `.env`. |
| Backup or restore | Perform a real write-quiesced backup and restore only into explicitly acknowledged disposable empty targets, then compare database and object evidence. |
| Exposed proxy or deployment | Validate configuration before reload and directly smoke only the changed HTTPS/TLS, readiness, session, storage, SMTP, CSP, restart, or rollback boundary. |
| Repository publication or Docker context | Run `npm run release:privacy:check`, build the `release` target, and inspect the image for forbidden agent/task artifacts. Release publication still requires its separate privacy/readiness review. |
| Dependency or security boundary | Run focused threat tests. Run `npm run security:deps` for dependency changes and review lockfile/lifecycle impact; automated remediation is never implicit authority for a breaking change. |
| Provider adapter | Run deterministic adapter/fake tests first. A real-provider smoke is optional evidence only under the permission and data limits below. |
| Retention or destructive data behavior | Run the focused migration contract and dry run first; execute deletion only when the requested scope explicitly authorizes it and only against the intended target. |
| MCP, ToolHive, or auth durability | Run focused deterministic tests first, then only the relevant opt-in integration command below against the disposable stack. External package pulls, hosted consent, and live OAuth require their own authority. |
| Document parser protocol or sidecar topology | Run deterministic routing/bounds/decoder fakes first, build the locally derived Docling image from its digest/checksum-pinned inputs, then run the parser smoke against that image and digest-pinned Tika in the disposable dev stack. Stop both parsers and prove feature-local unavailability while app readiness remains healthy. |

These rows are routing rules, not a cumulative release matrix. A change does not inherit unrelated checks because an earlier feature once used them.

## Canonical Opt-In Commands

The commands below are recorded because their environment gate, process boundary, or external effect is not reliably inferred from an ordinary focused-test name. Run only the entry point owned by the changed boundary.

### Migration contracts

Migration contracts create temporary databases or use bounded in-memory fixtures. Current entry points are:

```bash
npm run db:auth-rate-limit:migration:contract
npm run db:attachment-processing:migration:contract
npm run db:gemini:migration:contract
npm run db:knowledge:migration:contract
npm run db:knowledge-ingestion:migration:contract
npm run db:knowledge-run:migration:contract
npm run db:knowledge-policy:migration:contract
npm run db:memory:migration:contract
npm run db:provider:migration:contract
npm run db:full-access:migration:contract
npm run db:control-plane:migration:contract
npm run db:retention:migration:contract
npm run db:search:migration:contract
npm run db:assistants:migration:contract
npm run db:document-processing-fairness:migration:contract
```

Select the script owned by the migration; do not run this list as a generic release suite.

### Database and service integrations

Authentication admission concurrency/restart:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_AUTH_RATE_LIMIT_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/auth/prismaRateLimit.integration.test.ts
```

Provider Quick Setup repository integration:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_PROVIDER_QUICK_SETUP_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/admin/providers/quickSetupPrismaRepository.integration.test.ts
```

Assistant repository and run-acceptance authorization:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_ASSISTANTS_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/assistants/prismaRepository.integration.test.ts
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_ASSISTANT_RUN_AUTHORIZATION_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/runs/assistantProvenancePrismaRepository.integration.test.ts
```

Knowledge run admission, immutable binding persistence, and rollback after
access loss:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_KNOWLEDGE_RUN_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/runs/knowledgeRunBindingsPrismaRepository.integration.test.ts
```

Knowledge retrieval execution, immutable revision/generation filtering,
private receipts, negative outcomes, and EXPLAIN-backed HNSW/GIN paths:

```bash
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_KNOWLEDGE_RETRIEVAL_INTEGRATION_TEST=1 app \
  npx vitest run lib/server/knowledge/prismaRetrievalRepository.integration.test.ts
```

MCP protocol, database, and ToolHive boundaries:

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

The ToolHive case controls sibling Docker resources and may pull only its reviewed digest-pinned fixture. Live package-registry materialization, hosted consent, or brokered SaaS evidence remains separately authorized and sanitized; local metadata discovery alone is not end-to-end proof.

Document parser sidecars and feature-local failure:

```bash
docker compose -f docker-compose.dev.yml up -d --build --wait --wait-timeout 300
docker compose -f docker-compose.dev.yml exec -T app npm run smoke:parsers
docker compose -f docker-compose.dev.yml stop docling tika
docker compose -f docker-compose.dev.yml exec -T \
  -e AIQSA_TEST_MODE= \
  -e PLAYWRIGHT_TEST_AUTH= \
  -e AIQSA_BOOTSTRAP_LOGIN_ENABLED= \
  -e AIQSA_PARSER_SMOKE_EXPECT_UNAVAILABLE=1 app npm run smoke:parsers
docker compose -f docker-compose.dev.yml start docling tika
```

The smoke creates and removes tiny one-page native PDF, OOXML `.docx`, OLE Word
`.doc`, image-only PDF, PNG, JPEG, and WebP fixtures inside the app container. The
OCR fixtures contain printed Russian/English text, digits, and a simple table;
useful evidence requires stable prose, order-number, and table-only markers.
The exact built Docling image first verifies its offline EasyOCR assets. The
smoke calls the production parser boundary and emits only engines, counts,
page-anchor/marker and bounded OCR-evidence booleans, plus the
unavailability/readiness, local-PDF-fallback, and stable DOCX-error evidence;
extracted fixture text and raw sidecar responses remain private. Because the dev server deliberately fails readiness
while deterministic test-auth switches are enabled, the stopped-sidecar smoke
clears those switches only for its exact child process and calls the production
readiness route directly against the same Postgres and MinIO. An explicit
`AIQSA_PARSER_SMOKE_READINESS_URL` instead checks a running deployment over
HTTP. The stopped-sidecar step is valid only in the disposable dev topology
and must restore both services afterward.

The host-owned OCR benchmark reuses the same deterministic open-font,
300-DPI A4 grayscale fixture at 10, 50, and 100 image-only PDF pages:

```bash
npm run benchmark:knowledge-ocr
```

Run it only while the exact disposable Docling service is healthy. Before the
matrix it force-recreates only that disposable service with dependencies,
image builds, and pulls disabled, then fails closed unless the replacement has
the expected local tag, base-
digest and version labels, 2 CPU/10 GiB limits, one local worker, disabled boot
warm-up, one options-cache entry, matched four-page pipeline queues/batches, two inference
threads, a 290-second server wait, and the app has the 300-second client timeout;
it also executes the sealed offline asset verifier in the running container. It
records
fixture dimensions/bytes, wall time, peak container memory, normalized output
size, page/text evidence, and whether the current 290/300-second synchronous
boundary was reached. A recorded large-case timeout or Docker-event-verified
container OOM is evidence for a later async/page-slicing or resource decision,
not permission to raise the timeout/memory limit or a failure of the
small-document OCR contract. Any 10-page resource/deadline failure is recorded
and recovered but then fails the command; only measured 50/100-page limits are
accepted as large-case benchmark results. After either recoverable outcome, the benchmark
force-recreates only the disposable `docker-compose.dev.yml` `docling` service
with `--no-deps --no-build --pull never`, waits for health, and re-verifies the
exact tag/base/version identity, canonical resource/timing profile, and offline
OCR assets before continuing; the same recovery is performed after a final
large-case failure. Its JSON evidence records that replacement, health, and image
verification so one still-running conversion cannot contaminate the next matrix
item. A recovery failure is emitted beside the already measured case before the
remaining matrix stops.

### Provider smokes

Deterministic fake/fixture tests remain the default. The optional native Gemini smoke is permitted only with the operator-provided key for that process:

```bash
npm run smoke:gemini
```

It reads `GEMINI_API_KEY` and optional `AIQSA_GEMINI_SMOKE_MODEL`, uses the native v1 runtime with `store: false`, and keeps the call bounded. Output may contain only sanitized booleans, counts, status, and usage evidence; it must not print the key, response text, Suggestions markup, citation links, raw provider payload, or signatures. A missing key skips cleanly. Do not run large-context, deep-research, attachment-heavy, or long-background variants without fresh approval.

The same authorized smoke has an explicit unary request-shape variant for the
historical attachment-only edge case:

```bash
AIQSA_GEMINI_SMOKE_EMPTY_TEXT=1 npm run smoke:gemini
```

It sends the exact bounded `store: false` body produced by the current request
builder, requires the historical attachment marker with no empty text part,
HTTP 200 acceptance, a terminal response, and nonzero usage, and reports only
those booleans, HTTP status, step counts, and usage. It never prints provider
content or a raw payload.

With the same permission, the exact native Google Search stream/parser path is selected explicitly:

```bash
AIQSA_GEMINI_SMOKE_SEARCH=1 npm run smoke:gemini
```

This foreground bounded request uses medium thinking and reports only Search-step presence, Suggestions presence, counts, terminal output presence, status, and usage. It never prints the grounded answer, Suggestions, citations, URLs, payload, or signatures.

The Custom compatible smoke is local and credential-free:

```bash
npm run smoke:custom-openai-compatible
```

It uses an in-process loopback Chat Completions fixture, reads no provider key, and makes no external request. Other real-provider or gateway proof has no standing permission here; it requires explicit operator authorization, the smallest useful request, and sanitized evidence.

After explicit Anthropic authorization, the bounded Messages protocol smoke
reads `ANTHROPIC_API_KEY` and optional `AIQSA_ANTHROPIC_SMOKE_MODEL`:

```bash
npm run smoke:anthropic
```

It makes one tiny valid control request, one empty-text-block request, and one
request built through the production historical-attachment marker path. Output
is limited to acceptance booleans, HTTP status, content-block counts,
stop-reason presence, marker presence, and usage; it never prints message
content, response text, ids, raw payloads, or the key. A missing key skips
cleanly. Refusal and context-window probes are deliberately excluded because
safely forcing those terminal shapes would require a harmful or unbounded
request.

After that explicit authorization, the direct OpenAI Responses smoke reads `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and optional `AIQSA_DEFAULT_MODEL`:

```bash
npm run smoke:openai
AIQSA_OPENAI_SMOKE_SEARCH=1 npm run smoke:openai
```

Both modes are foreground and `store: false`. The second adds the hosted `web_search` tool and requires normalized source evidence. Output is limited to booleans, counts, status, and usage; it never prints response text, source URLs, provider payloads, or the key. A missing key skips cleanly.
