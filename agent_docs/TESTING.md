# TESTING

Owner: Verification maintainers
Scope: Test-level selection, canonical commands, disposable boundaries, evidence, and authoring rules.

## Selection Rule

Use the cheapest deterministic check that proves the increment, then run the completion lane proportional to the changed boundary. Documentation-only work runs `npm run docs:check`. Pure code normally completes through the hermetic lane. Add database, browser, image, dependency, deployment, or provider evidence only when the change crosses that boundary.

`scripts/docs-manifest.mjs` owns the small mandatory document set and budgets. The docs checker verifies required owners, handwritten-document budgets/orphans, and internal links; it does not mirror source inventories, encode implementation prose, or inspect task-ledger state. Task-ledger changes run `npm run task:check` explicitly plus focused ledger/privacy tests; this remains independent of documentation validation.

## Core Lanes

Install from the lockfile in a clean checkout:

```bash
npm ci
```

Iterate narrowly:

```bash
npm test -- <test-files>
npx eslint <changed-paths>
npx tsc --noEmit
```

Complete deterministic application work with:

```bash
npm run check:hermetic
```

This generates Prisma, checks docs, lints, type-checks, and runs deterministic Vitest/Testing Library tests without a database, Docker, provider keys, or external services. `*.prisma.test.*` and `*.integration.test.*` belong only to the full stateful project.

Use disposable container parity for PostgreSQL, migrations, concurrency, service/process topology, or another real integration boundary:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
```

The full lane deploys committed migrations and runs deterministic plus stateful tests against the exact acknowledged disposable database. Stateful/container checks are serialized. The default `docker-compose.yml` is a persistent installation and is never a test target.

`test:full:inner` is an internal command for the disposable development container and intentionally fails closed on the host. Use `check:container` for the full lane; when an already migrated disposable stack is running, a focused stateful file may be passed to `test:full:inner` only from that app container.

Use Playwright only for browser/server routing, auth/session, streaming, responsive geometry/input, or focus behavior:

```bash
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
```

This may reset disposable data and must not overlap another stateful check. Reusable-server focused specs are allowed only when their fixtures own no reset/global mutation. Store task-owned browser output under a fresh `/tmp` path when default artifacts are not writable; never delete another process's artifacts.

Knowledge changes use small co-located tests through the same narrow, hermetic, container, and browser lanes. Select only the executable owners crossed by the change and prove the applicable contracts:

- tenant, Project, direct-Source, Base, and `All my knowledge` scope isolation;
- one canonical Source vote across overlapping Bases;
- the sole strict `search_knowledge({ query, sourceAliases })` descriptor, Unicode/code-point bounds, rejection of hidden controls, an empty alias list on the broad first call, and later narrowing only to previously disclosed Sources;
- no generated focused request on new runs, plus read/recovery compatibility for accepted historical focused runs;
- Search, Knowledge, MCP, attachments, Assistants, and Personal Memory context remain independently composable;
- one query embedding per compatible Profile and one hybrid repository operation per accepted Knowledge call, with at most sixteen broad-map results and eight Source-scoped reduce results;
- installation-scoped Knowledge-search limits (default `12`, bounded `1..32`), pre-I/O rejection of the next over-budget call, authority/egress rechecks, and bounded timeout;
- normal hybrid retrieval plus classified query-embedding degradation to exact, metadata, and `simple`/English/Russian lexical lanes, while database, authority, SQL, and invariant failures remain visible;
- named relevance eligibility before weighted reciprocal-rank fusion, exact preservation, weak-nearest-neighbor rejection, content deduplication, cross-call evidence novelty, soft Source diversity, and same-Source neighbor bounds;
- completed result replay in execution/recovery and normal `no_relevant_evidence` continuation after every generated candidate is ineligible;
- real PostgreSQL `pg_trgm` evidence for query-first containment-like metadata matching, including beginning, middle, and irrelevant stored values;
- exact checkpoint-delivered handle binding, Source Version/locator attribution, ordinary Markdown, and no second generation;
- distinct processing, partial-ready, zero-candidate, insufficient-evidence, retrieval, provider, and contract outcomes;
- embedding-free Source-local reads, bounded exact search, and metadata-only discovery;
- recovery never repeats settled or crash-ambiguous provider I/O;
- adaptive full-context admission proves the entire canonical ready corpus is retained inside the frozen provider budget with zero query embeddings and zero Knowledge-search calls, otherwise routing falls back to RAG before provider I/O;
- one session per run, durable full-context evidence without synthetic retrieval receipts, and one receipt per actual RAG Knowledge call with exact binding persistence/replay;
- replacement/deletion immutability, private-payload purge, and content-free logs/client projections;
- normalized page, heading, table, form, OCR, and layout locators remain attributable citation context.

These are binary technical contracts. Keep one tiny fixture per named defect and no more than six tiny documents in a shared Knowledge fixture. Do not add scored corpora, labels, expected-answer collections, frozen outputs, or large question sets. The owner may inspect a few private documents manually after completion, but those results are neither repository artifacts nor an implementation gate.

## Boundary Evidence

| Changed boundary | Additional evidence |
| --- | --- |
| Prisma schema/migration/bootstrap | `npm run db:migration:smoke`; use `npm run db:baseline:contract` for baseline/custom PostgreSQL DDL or adoption logic. Both create only acknowledged disposable databases. |
| Compose/image/installation | Focused config tests, release-target build, fresh bootstrap/adoption, non-root roles, and unique disposable project plus volume/image identities. |
| Backup/restore or destructive retention | Dry run first, then real backup/empty-target restore or deletion only when explicitly authorized against disposable/intended targets. |
| Browser interaction/visual composition | Focused component tests, then affected browser states/viewports/themes; assert observable state, focus, containment, geometry, and overflow rather than screenshots. |
| Provider adapter | Deterministic request/stream/parser/fake tests first; real smoke only under the permission below. |
| Dependency/security | Focused threat tests and `npm run security:deps`; review manifest, lockfile, lifecycle scripts, and any override/upstream contract. |
| MCP/ToolHive/OAuth | Deterministic protocol/security tests, then the relevant disposable local runtime. Registry pulls, hosted consent, upstream OAuth, and Docker-side effects need separate authority. |
| Upload/parser sidecars | Deterministic routing/bounds/decoder tests, then the parser smoke in disposable Compose; prove stopped parsers degrade locally without breaking core readiness. |
| Memory/Knowledge/recovery/concurrency | Pure policy/source/handler tests, then focused container-internal `test:full:inner` cases or container parity against disposable PostgreSQL/pgvector. Evidence is aggregate and content-free. |
| Repository publication | `npm run release:privacy:check`, inspected-tree release build, and image inspection; publication/tag/ref changes still need explicit authority. |

These are routing rules, not a cumulative release matrix. Do not run unrelated expensive lanes because another task once used them.

## External And Opt-In Checks

Fake providers are the automation default. `npm run smoke:custom-openai-compatible` is a local credential-free fixture. `npm run smoke:gemini` may run only with the current operator-provided key, bounded request, and sanitized output; missing key skips. Anthropic, OpenAI, OpenRouter, hosted Search, OAuth/registry, or other real-provider smokes require explicit operator authorization for that provider and the smallest useful call. Never print keys, prompts, answers, sources/URLs, private IDs, or raw payloads.

Independent public Knowledge retrieval evaluation is a separate opt-in workspace owned by [`benchmarks/knowledge/README.md`](../benchmarks/knowledge/README.md), never a default hermetic or release gate. It requires an isolated disposable Compose project with distinct ports/volumes, an explicit paid-work acknowledgement and provider permission, frozen public dataset revisions, conservative canary-first concurrency, and content-free checkpoint/results. Corpora, queries, rankings, credentials, and run state remain ignored; only harness contracts and aggregate documentation belong in the repository. Scored corpora and relevance labels remain forbidden in ordinary co-located tests.

`npm run security:deps` is the approved external npm advisory check during dependency work. Network failure may be retried with the required sandbox escalation. Its remediation suggestions are evidence, not authority for a breaking upgrade.

Parser, Memory semantic, backup/restore, MCP runtime, and deployment smokes use their checked-in scripts as the executable command/source of bounds. Read the script and relevant owner before running; do not copy exact test-file matrices into prose. `npm run smoke:memory-semantic` has standing permission only for the bounded loopback disposable app using credentials already stored through Admin and sanitized aggregate output; it has no permission for a persistent or non-loopback installation.

`npm run smoke:memory-browser-paid` is an optional, non-gating Playwright smoke for the local disposable Compose stand. It has no standing paid-provider permission: set `AIQSA_MEMORY_BROWSER_PAID_SMOKE=DISPOSABLE`, provide the exact loopback `AIQSA_MEMORY_BROWSER_PAID_SMOKE_DATABASE_URL`, and select either the `DIRECT` or `DREAM` scenario through `AIQSA_MEMORY_BROWSER_PAID_SMOKE_SCENARIO` only after the operator authorizes paid calls. Run both scenarios separately when full browser evidence is wanted. The script requires the dev profile's 120-second Memory admission timeout, emits sanitized aggregates, bounds provider work, and permanently deletes only chats and Memory refs it created. A successful `DREAM` result may contain either one classified/retrieved pattern or a structurally valid empty synthesis result; do not reroll an unchanged source set to force a model-authored pattern.

## Test Authoring And Completion

Test observable contracts, not implementation shape. Add the cheapest deterministic regression. Keep fixtures small, isolated, content-safe, and order-independent; `.only`, broad snapshots, permanent environment skips, real paid calls, and unowned global cleanup are forbidden. Explicitly cover loading/error/empty and lifecycle terminals when changed.

Database/integration tests fail closed unless the acknowledged disposable target is present. Migration, prune, backup, browser reset, and installation tests validate exact targets before mutation and clean only resources they own. Sanitize external evidence to booleans, counts, stable codes, versions, plan names, latency, and bounded limits.

Before completion, run the root task-owned status/diff checks, inspect the complete task diff and new files, reject secrets/artifacts/unrelated drift, and record exact checks plus specific reasons for any relevant omission. Required-but-unavailable evidence blocks completion.
