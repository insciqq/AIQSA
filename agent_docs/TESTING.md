# TESTING

Owner: Verification maintainers
Scope: Test-level selection, canonical commands, disposable boundaries, evidence, and authoring rules.

## Selection Rule

Use the cheapest deterministic check that proves the increment, then run the completion lane proportional to the changed boundary. Documentation-only work runs `npm run docs:check`; generated-reference work also runs `npm run docs:generated:check`. Pure code normally completes through the hermetic lane. Add database, browser, image, dependency, deployment, or provider evidence only when the change crosses that boundary.

`scripts/docs-manifest.mjs` owns the small mandatory document set and budgets. The docs checker verifies required owners, handwritten-document budgets/orphans, internal links, and generated freshness; it does not encode implementation prose or task-ledger state.

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

Use Playwright only for browser/server routing, auth/session, streaming, responsive geometry/input, or focus behavior:

```bash
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
```

This may reset disposable data and must not overlap another stateful check. Reusable-server focused specs are allowed only when their fixtures own no reset/global mutation. Store task-owned browser output under a fresh `/tmp` path when default artifacts are not writable; never delete another process's artifacts.

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
| Memory/Knowledge/recovery/concurrency | Pure policy/source/handler tests, then focused `test:full` cases or container parity against disposable PostgreSQL/pgvector. Evidence is aggregate and content-free. |
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
