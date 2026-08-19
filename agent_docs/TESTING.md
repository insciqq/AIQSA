# TESTING

Owner: Verification maintainers
Scope: Test-level selection, canonical commands, disposable boundaries, evidence, and authoring rules.

## Selection Rule

Use the cheapest deterministic check that proves the increment, then run the completion lane proportional to the changed boundary. Documentation-only work runs `npm run docs:check`. Pure code normally completes through the hermetic lane. Add database, browser, image, dependency, deployment, or provider evidence only when the change crosses that boundary.

`scripts/docs-manifest.mjs` owns the small mandatory document set and budgets. The docs checker verifies required owners, handwritten-document budgets/orphans, and internal links; it does not mirror source inventories, encode implementation prose, or inspect task-ledger state.
Task-ledger changes run `npm run task:check` explicitly plus focused ledger/privacy tests; this remains independent of documentation validation.

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

Knowledge retrieval changes compare against the synthetic, aggregate-only current baseline with:

```bash
npm run eval:knowledge:baseline
```

The command owns and cleans its fixtures, starts only the disposable development dependencies, validates the corpus/query labels, and fails closed for any non-disposable database. It records current quality rather than treating the current values as launch gates; later retrieval stages define regression tolerances and production gates against the versioned report contract.

Hierarchical lexical/exact index changes run their Stage 4 quality and plan gates with:

```bash
npm run eval:knowledge:indexes
```

This disposable PostgreSQL evaluation builds immutable shadow artifacts for the ready golden corpus and emits aggregate-only document/section/passage recall, multilingual and exact-query quality, scope isolation, bounded-scan, immutability, latency, and GIN/trigram plan evidence. Unlike the baseline command, its versioned thresholds are acceptance gates and a miss fails the command.

Adaptive vector and ranking changes run the full Stage 4 retrieval gate with:

```bash
npm run eval:knowledge:retrieval
```

The disposable evaluation compares exact and ANN results across measured scope slices, requires the intended HNSW plans and scope isolation, and gates multilingual/exact/comparison quality, no-answer and duplicate rates, processing-Source behavior, embedding and reranker outages, latency, and private-evidence projection. It owns and removes its synthetic fixtures and emits only sanitized aggregates, limits, and plan evidence.

Release-scale catalog changes run the disposable Source/Base latency and isolation gate with:

```bash
npm run eval:knowledge:scale
```

The gate exercises one user with 500 Sources across multiple Bases plus many small private-owner Bases, verifies owner isolation, and enforces the current server-side list p95 target without provider calls. It owns its mutable fixtures and reports only counts and aggregate timings.

Grounded answer or citation-contract changes run the deterministic aggregate-only gate with:

```bash
npm run eval:knowledge:grounding
```

The gate covers English/Russian cited answers, v2 handle validity and evidence availability, deterministic normalization of handle-only grouped/alternate citation syntax, Source-local numeric/date binding, cross-Source field-mixing rejection, ambiguous-table abstention, novel or calculated numeric literals, no-ready and partial-readiness no-answer, truthful citation-binding failure, unverified coverage claims, general-knowledge separation when no Source citation exists, deleted evidence, internal identities, prompt injection, dated-comparison non-regression, and the one-repair ceiling. This cheap runtime gate intentionally does not score general semantic entailment, guess citations for uncited claims, or infer generic contradictions between evidence passages. Its report contains only counts, thresholds, and aggregate metrics.

Spreadsheet normalization, planning, execution, or range-receipt changes run the deterministic aggregate-only gate with:

```bash
npm run eval:knowledge:structured
```

The gate covers XLS/XLSX/ODS plus CSV formula-injection handling, numeric/date/locale/missing/hidden/cached-formula correctness, multi-sheet joins, ambiguity and ordinary-retrieval routing, resource failures, and a local execution-latency envelope. Its report contains only counts, rates, bounds, and latency.

Visual asset selection, vision policy/runtime, or visual-receipt changes run the deterministic provider-fake gate with:

```bash
npm run eval:knowledge:visual
```

The gate covers exact original regions, admitted-scope isolation, separately approved egress, source-size bounds, prompt injection, ambiguity, local-only and provider-outage degradation, and ordinary text fallback. Its report contains only counts, thresholds, and pass rates; the affected original-first viewer states are verified separately in the browser lane.

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

`npm run security:deps` is the approved external npm advisory check during dependency work. Network failure may be retried with the required sandbox escalation. Its remediation suggestions are evidence, not authority for a breaking upgrade.

Parser, Memory semantic, backup/restore, MCP runtime, and deployment smokes use their checked-in scripts as the executable command/source of bounds. Read the script and relevant owner before running; do not copy exact test-file matrices into prose. `npm run smoke:memory-semantic` has standing permission only for the bounded loopback disposable app using credentials already stored through Admin and sanitized aggregate output; it has no permission for a persistent or non-loopback installation.

## Test Authoring And Completion

Test observable contracts, not implementation shape. Add the cheapest deterministic regression. Keep fixtures small, isolated, content-safe, and order-independent; `.only`, broad snapshots, permanent environment skips, real paid calls, and unowned global cleanup are forbidden. Explicitly cover loading/error/empty and lifecycle terminals when changed.

Database/integration tests fail closed unless the acknowledged disposable target is present. Migration, prune, backup, browser reset, and installation tests validate exact targets before mutation and clean only resources they own. Sanitize external evidence to booleans, counts, stable codes, versions, plan names, latency, and bounded limits.

Before completion, run the root task-owned status/diff checks, inspect the complete task diff and new files, reject secrets/artifacts/unrelated drift, and record exact checks plus specific reasons for any relevant omission. Required-but-unavailable evidence blocks completion.
