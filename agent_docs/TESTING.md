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

`scripts/docs-manifest.mjs` is the sole compact inventory of mandatory
documentation. The checker enforces only mechanically verifiable repository
contracts: required files, local links, scoped instruction imports and budgets,
documented example environment keys, generated-reference drift, and private
task-ledger state. Document size, prose similarity, and narrative organization
remain review concerns rather than executable policy.

## Core Verification Lanes

### Focused and hermetic

Bootstrap a clean checkout from the lockfile, then use the host-local lane:

```bash
npm ci
npm run check:hermetic
```

`check:hermetic` generates the Prisma client without connecting to a database,
runs documentation/reference drift checks, ESLint, TypeScript, and every
deterministic Vitest/Testing Library case through the default
`vitest.config.ts`. Files named `*.prisma.test.*` and
`*.integration.test.*` stay outside this lane; direct-database tests must use
one of those suffixes. The lane requires no Docker, `DATABASE_URL`, provider
key, or external service. The ordinary PR/push workflow runs only `npm ci` and
this authoritative command, with no secrets, database, or Docker service.

Keep iteration narrower when possible:

```bash
npm test -- <test-files>
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

`check:container` executes the full container/stateful test matrix in a fresh
bounded one-shot app container, including PostgreSQL-backed repository and
concurrency cases. It first deploys every committed migration to the disposable
development schema so the generated client and database can never drift. The
required preceding hermetic lane owns full-repository
lint and TypeScript; container parity does not repeat those memory-heavy static
passes. It has fixed 2 GiB and two-CPU cgroup boundaries, uses a 1.5 GiB Node
heap and one Vitest worker, and never runs the toolchain inside the warmed
Next/Turbopack dev process. Its unique container name also rejects a concurrent second check. Dev
Compose caps other app containers with `AIQSA_APP_MEMORY_LIMIT` (3 GiB by
default) and `AIQSA_APP_CPU_LIMIT` (four CPUs by default).
The bounded container command uses one worker for the complete matrix; direct
invocations of `npm run test:full` keep the hermetic project on normal Vitest
workers while the stateful project always uses one worker and no file
parallelism because its cases share the disposable schema. The full entrypoint
also refuses any target except the exact acknowledged test-mode database URL
from `docker-compose.dev.yml`.
A small documentation, pure-domain, component-unit, or deterministic adapter
change does not require Compose merely because it changes application code.

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

When a prior container run left the default result directory host-unwritable,
set `AIQSA_PLAYWRIGHT_OUTPUT_DIR` to a fresh task-owned path under `/tmp` rather
than changing or deleting another process's artifacts.

Use the standalone `run --rm` form when the selected spec requires the configured reset and loss of interactive development fixtures is acceptable. Automated browser coverage does not use screenshot or pixel-baseline assertions. Assert observable behavior instead: roles and labels, focus ownership, state transitions, containment, geometry, overflow, breakpoint composition, and theme state. Material visual changes may still be inspected directly during implementation, but screenshots are neither stored test fixtures nor an automated acceptance gate. Local auth fixtures and session-mutation safety are owned by the bounded security contracts routed by `SECURITY.md`.

## Test Authoring

- Test observable behavior and stable contracts, not implementation shape.
- Add the cheapest deterministic regression test; add browser, database, container, or real-service coverage only for a genuine boundary risk.
- Focused `.only` tests are forbidden in Vitest and Playwright configuration; focus with the command line while iterating.
- Prefer stable visible roles and labels when they describe product behavior; use test ids where they are clearer or more durable.
- Use fake providers in automated tests. Vitest and routine Playwright never make paid external calls.
- Preserve explicit loading, error, empty, queued, streaming, cancelled, and terminal states when changing their owner.
- Keep fixtures small and isolated; avoid broad snapshots, duplicated governance assertions, or dependence on execution order.
- Database/integration tests belong only to the explicit full lane. Once selected there, they must run against the acknowledged disposable target or fail closed; do not encode permanent environment-driven skips. Create isolated schemas/resources where supported and clean only what the test owns.
- Migration, backup, prune, browser-reset, and installation tests must validate their exact disposable target before mutation.
- Sanitize external evidence to stable booleans, counts, codes, and bounded metadata. Never emit secrets, private content, raw upstream responses, or provider-rendered answer text merely to prove a smoke passed.

## Boundary-Specific Evidence

Add only evidence justified by the changed boundary:

| Changed boundary | Proportional evidence |
| --- | --- |
| Prisma schema, append-only migration, seed, bootstrap, or database repository | Run the one-database migration smoke with ordered deploy, repeat deploy, seed/bootstrap, and integrity checks against an explicitly disposable database. Never use a persistent installation as a migration test target. |
| Baseline, custom PostgreSQL function/trigger/index/generated column/deferred constraint, or bootstrap adoption logic | Run the full baseline contract across two independent disposable databases after the focused migration smoke. |
| Installation bootstrap, image, or Compose topology | Run focused bootstrap/config tests, build the single `release` target, and prove fresh bootstrap plus adopted repeat in a uniquely named disposable project. Stable volume/image names require unique temporary `AIQSA_POSTGRES_VOLUME_NAME`, `AIQSA_MINIO_VOLUME_NAME`, `AIQSA_TOOLHIVE_VOLUME_NAME`, and `AIQSA_IMAGE`; `-p` alone is not isolation. Prove update preservation and the required non-root runtime roles when those behaviors changed. |
| First-install helper | Run shell syntax plus its focused harness test against temporary files; never invoke it against the repository's real `.env`. |
| Backup or restore | Perform a real write-quiesced backup and restore only into explicitly acknowledged disposable empty targets, then compare database and object evidence. |
| Exposed proxy or deployment | Validate configuration before reload and directly smoke only the changed HTTPS/TLS, readiness, session, storage, SMTP, CSP, restart, or rollback boundary. |
| Repository publication or Docker context | Run `npm run release:privacy:check`, build the `release` target, and inspect the image for forbidden agent/task artifacts. Release publication still requires its separate privacy/readiness review. |
| Dependency or security boundary | Run focused threat tests. Run `npm run security:deps` for dependency changes and review lockfile/lifecycle impact; automated remediation is never implicit authority for a breaking change. |
| Provider adapter | Run deterministic adapter/fake tests first. A real-provider smoke is optional evidence only under the permission and data limits below. |
| Retention or destructive data behavior | Run the focused retention tests and dry run first; execute deletion only when the requested scope explicitly authorizes it and only against the intended target. |
| Native Memory phase gate | Run pure source/safety/handler fixtures first, then the exact stateful phase matrix below against disposable PostgreSQL/pgvector. Evidence may contain only aggregate counts, booleans, versions, plan names, Recall@k, latency, and job lag—never source text, embeddings, account IDs, or provider bodies. |
| MCP, ToolHive, or auth durability | Run focused deterministic tests first, then the relevant explicit full-lane or local-runtime smoke against the disposable stack. External package pulls, hosted consent, and live OAuth require their own authority. |
| Document parser protocol or sidecar topology | Run deterministic routing/bounds/decoder fakes first, build the locally derived Docling image from its digest/checksum-pinned inputs, then run the parser smoke against that image and digest-pinned Tika in the disposable dev stack. Stop both parsers and prove feature-local unavailability while app readiness remains healthy. |

These rows are routing rules, not a cumulative release matrix. A change does not inherit unrelated checks because an earlier feature once used them.

## Canonical Opt-In Commands

The commands below are recorded because their environment gate, process boundary, or external effect is not reliably inferred from an ordinary focused-test name. Run only the entry point owned by the changed boundary.

### Migration smoke and baseline contract

The ordinary migration smoke creates one uniquely named disposable database
inside the development PostgreSQL service. It deploys the complete ordered
committed migration set twice, checks status, and proves seed, bootstrap, and
schema integrity:

```bash
npm run db:migration:smoke
```

Baseline and custom PostgreSQL DDL changes additionally use the same
implementation in full mode. It creates two independent clean databases and
proves the seed/integrity and fresh/adopted bootstrap paths separately:

```bash
npm run db:baseline:contract
```

### Database and service integrations

Native Memory source settlement through default-on learning and three-tier
retrieval: recognizable-format safety projection, lexical/vector chunk/fact
indexing, extraction/consolidation, Core and automatic retrieval, unified search,
review feedback/conflict resolution, rebuild/recovery, and destructive replay:

```bash
docker compose -f docker-compose.dev.yml exec -T app \
  npm run test:full -- \
  lib/server/memory/coordinator/defaultCoordinator.test.ts \
  lib/server/memory/history/sourceProjection.test.ts \
  lib/server/memory/history/chunking.test.ts \
  lib/server/memory/history/handler.test.ts \
  lib/server/memory/history/repository.prisma.test.ts \
  lib/server/memory/learning/extraction/repository.prisma.test.ts \
  lib/server/memory/learning/consolidation/repository.prisma.test.ts \
  lib/server/memory/review/repository.prisma.test.ts \
  lib/server/memory/embedding/prismaEmbedding.prisma.test.ts \
  lib/server/memory/retrieval/localRepository.prisma.test.ts \
  lib/server/memory/retrieval/vector.prisma.test.ts \
  lib/server/memory/rebuild/prismaRebuild.prisma.test.ts \
  lib/server/memory/lifecycle/prismaLifecycle.prisma.test.ts
```

The operator-authorized production-path Memory smoke runs only against a local
disposable app already bounded to two CPUs and two GiB. It refreshes exact
active answer/System/embedding tuples when stale, acknowledges the current
installation egress fingerprint, performs a real `REEMBED`, and then proves two
automatic-fact recall paths plus one non-Core cross-language vector/history
path through private recovery checkpoints:

```bash
npm run smoke:memory-semantic
```

The runner reads the local bootstrap token only for loopback authentication and
uses provider credentials already stored through Admin; it never exports a
provider key. Output is limited to aggregate booleans/counts and SHA-256
digests. It never prints Memory/query/source or answer text, account/chat/run/
message/fact IDs, credentials, provider responses, or private checkpoint passages. This
command has no standing permission for a persistent or non-loopback install.

Write-quiesced backup, wrong-key rejection, empty-target restore, unresolved
account-obligation rejection, deletion-only review, and private promotion
receipt use uniquely named disposable source/restore projects and clean their
volumes on exit:

```bash
npm run test:backup-restore
```

The vector fixture uses PostgreSQL 16/pgvector 0.8, 5,001 eligible rows and
closer foreign-tenant rows, plus incompatible generations/dimensions. It emits
only a sanitized aggregate with Recall@5, exact/HNSW plan booleans, query p95,
and zero leakage counts. The local-retrieval fixture emits sanitized
multi-script/cross-language Recall@5, irrelevant-injection, candidate-bound,
isolation, and query-p95 evidence while exercising temporal and suppression filters. The history fixture
emits only searchable-row count and enqueue-to-commit job lag. Test fixture IDs
and content are explicitly excluded from every evidence object.

MCP protocol and local remote-runtime boundaries:

```bash
docker compose -f docker-compose.dev.yml exec -T app \
  npm test -- lib/server/mcp/oauthService.test.ts
docker compose -f docker-compose.dev.yml exec -T app \
  npm run test:full -- lib/server/mcp/remoteRuntime.integration.test.ts
```

The remote-runtime case starts only a bounded local SDK fixture. Live package-registry materialization, hosted consent, brokered SaaS evidence, or sibling Docker control remains separately authorized and sanitized; local metadata discovery alone is not end-to-end proof.

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

### Provider smokes

Deterministic fake/fixture tests remain the default. The optional native Gemini smoke is permitted only with the operator-provided key for that process:

```bash
npm run smoke:gemini
```

It reads `GEMINI_API_KEY` and optional `AIQSA_GEMINI_SMOKE_MODEL`, uses the native v1 runtime with `store: false`, and keeps the call bounded. Output may contain only sanitized booleans, counts, status, and usage evidence; it must not print the key, response text, Suggestions markup, citation links, raw provider payload, or signatures. A missing key skips cleanly. Do not run large-context, deep-research, attachment-heavy, or long-background variants without fresh approval.

The same authorized smoke has an explicit unary request-shape variant for a
prior attachment-only turn:

```bash
AIQSA_GEMINI_SMOKE_ATTACHMENT_CONTEXT=1 npm run smoke:gemini
```

It sends the exact bounded `store: false` body produced by the current request
builder, requires the prior-turn attachment marker with no empty text part,
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
request built through the production prior-turn attachment-marker path. Output
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
