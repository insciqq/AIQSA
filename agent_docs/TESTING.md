# TESTING

Owns verification selection, target safety, external-call permission, and test authoring. Run the cheapest deterministic check that proves the increment, then the completion lane proportional to the changed boundary. Unrelated expensive lanes are not cumulative release requirements.

## Core Lanes

Install with `npm ci`. Iterate with `npm test -- <test-files>`, `npx eslint <changed-paths>`, and `npx tsc --noEmit` as applicable.

| Change | Completion evidence |
| --- | --- |
| Documentation only | `npm run docs:check` |
| Deterministic code | `npm run check:hermetic` (Prisma generation, docs, lint, types, deterministic tests; no database/provider keys) |
| Database, concurrency, process/service boundary | Disposable container parity below |
| Browser/server routing, auth/session, streaming, geometry/input/focus | Focused components plus affected Playwright states |

Cold full checks may exceed Node's default heap; use `NODE_OPTIONS=--max-old-space-size=8192 npm run check:hermetic`, matching [CI](../.github/workflows/ci.yml). Stale generated `.next` types can reference deleted routes; verify in a clean checkout rather than changing source to satisfy old generated files.

Read [Environment](ENV_VARIABLES.md) first. Preserve the checkout's configuration and operator profile; use a unique acknowledged disposable project for stateful work. Never target the persistent installation. Commands for the disposable topology:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
```

Select only the needed commands. Container parity deploys committed migrations and runs deterministic plus stateful tests. `*.prisma.test.*` and `*.integration.test.*` are excluded from the hermetic project. `test:full:inner` runs only inside the acknowledged disposable app container; an already migrated stand may run a focused file there.

Serialize stateful/container/browser-reset checks. Reusable-server specs may overlap only when they own no reset/global mutation. Use a fresh `/tmp` directory for task-owned browser output when necessary; never delete another process's artifacts.

## Boundary Evidence

| Changed boundary | Additional evidence |
| --- | --- |
| Schema, migration, bootstrap | `npm run db:migration:smoke`; `npm run db:baseline:contract` for baseline/custom PostgreSQL DDL/adoption. Only acknowledged disposable databases. |
| Compose, image, installation | Focused config tests, release-target build, fresh bootstrap/adoption, non-root roles, and isolated project/volume/image identities. |
| Backup/restore, destructive retention | Dry run first; real backup/empty-target restore/deletion only with explicit authority over disposable/intended targets. Production procedures belong to the separate infrastructure workspace. |
| UI | Affected browser states, themes, viewports, focus transitions, containment and overflow; see [Frontend](FRONTEND.md). |
| Provider | Deterministic request/stream/parser/fake checks first; real calls require the permission below. |
| Dependencies/security | Focused threat checks and `npm run security:deps`; review manifest, lockfile, lifecycle scripts, overrides and upstream compatibility. |
| MCP/ToolHive/OAuth | Deterministic protocol/security tests, then relevant disposable runtime. Registry pulls, hosted consent, upstream OAuth and Docker side effects require their own authority. |
| Workspace/KVM | Policy/protocol/output tests, disposable database race checks, release/runner/guest image builds and reproducible guest identity, isolated browser flows, then opt-in real KVM evidence. Cover execution loss, Stop without delayed side effects, runner restart, export/recovery, file integrity, network modes and cleanup. A fake runtime is never live evidence. |
| Upload/parser sidecars | Deterministic routing/bounds/decoders, then disposable parser smoke; stopped parsers degrade locally without breaking core readiness. |
| Memory/Knowledge/recovery | Focused policy/handler tests, then disposable PostgreSQL/pgvector for persistence/concurrency and isolated OpenSearch for retrieval/projection changes. Integrity/rebuild output is content-free. |
| Publication | `npm run release:privacy:check`, inspected-tree release build and image inspection. Tags, pushes and publication still require explicit operator authority. |

The release workflow also runs `node scripts/production-smoke.mjs --disposable <image-map.json>` against the built production images. It owns a fresh project and synthetic data, verifies initialization and image replacement with a forward migration, checks that credentials/settings/a chat survive repeated updates, and proves that a failed migration blocks the new app. Never substitute an existing installation for this target. Changes to production installation/release wiring run this pipeline on `main` without updating stable image tags or creating a release; publication still requires a release tag.

Numbered release candidates (`vX.Y.Z-rc.N`) use a fast publication lane: run the applicable local verification above, the privacy check, and an inspected-tree release build before tagging. CI then builds/publishes without repeating the technical gates or installation smoke. A successful RC workflow proves publication, not a full CI qualification. Stable releases retain all gates. RCs update only their versioned images and the separate `rc` image channel; unchanged infrastructure may reuse a published stable image by digest. Never replace stable tags with candidate images.

Knowledge tests prove the changed scope, evidence-delivery, citation, egress, degradation or immutability contract with tiny fixtures. Keep ordinary co-located tests free of scored corpora, relevance labels, expected-answer collections and large question sets. Optional manual document inspection is not an implementation gate.

`docs:check` owns required documents, orphan/link checks, and text budgets through [docs-manifest](../scripts/docs-manifest.mjs). It neither inventories implementation nor validates task state. Task-ledger changes separately run `npm run task:check` and focused ledger/privacy tests.

## External And Opt-In Checks

Fake providers are the default. Never print keys, prompts, answers, source text/URLs, private identifiers, raw tool payloads, or capability-bearing paths. Evidence is limited to versions, stable codes, booleans, counts, latency, limits, hashes and cleanup results.

- `smoke:custom-openai-compatible` is credential-free and local.
- `smoke:gemini` may use a current operator-provided key for a bounded request with sanitized output; a missing key skips.
- Anthropic, OpenAI, OpenRouter, hosted Search, OAuth/registry and other real-provider calls require explicit provider-specific authorization and the smallest useful call.
- `smoke:memory-semantic` has standing permission only for the bounded loopback disposable app using credentials already stored through Admin and sanitized aggregate output. No persistent/non-loopback authority is implied.
- `security:deps` is the approved external npm advisory check during dependency work under [Security](SECURITY.md). Network failure may be retried with required sandbox escalation; audit suggestions do not authorize breaking upgrades.

Read an opt-in script and its guards before running it. Exact flags, fixtures, limits, cleanup and assertions belong to that script, not this document.

Workspace receiver/export/file-integrity browser fixtures run alone in isolated Compose. Live operation-fence evidence runs as the sole command in a disposable KVM runner with one receiver/guest; database lease-expiry evidence remains separate. `smoke:workspace-live` requires explicit disposable opt-in, real KVM, and synthetic owned sessions/objects. `smoke:workspace-user-paid` is optional and outside default/release gates: it additionally requires explicit paid codex-lb permission, a fresh isolated topology satisfying [its guards](../scripts/workspace-user-paid-support.ts), sequential guests and independent artifact oracles. Diagnose a failure before a paid retry; clean only its resources.

`smoke:memory-browser-paid` and `smoke:memory-mcp-codex` have no standing paid permission. Both require their explicit disposable target and sanitized evidence. The inbound MCP smoke owns a fresh database, app origin, synthetic account, isolated client configuration and real browser OAuth; it must prove native fact parity, revocation, lexical/semantic retrieval and absence of chat artifacts independently of the generated answer. The browser DREAM scenario may validly produce no pattern; never reroll an unchanged source set to force one.

Any unexplained Personal Memory `DEGRADED` result blocks a provider smoke, benchmark or qualification even if the answer is correct. Diagnose and fix the shared path or prove that the scenario deliberately injected that fallback. A clean qualification has zero unexplained degradation.

Benchmark suites are opt-in and excluded from product lint/types/tests. [Knowledge benchmarks](../benchmarks/knowledge/README.md) require isolated disposable infrastructure, paid-work/provider permission, frozen public datasets, conservative canary-first concurrency and content-free outputs. Corpora and run state remain ignored. LongMemEval contracts run through `npm run test:benchmark:longmemeval`; a frozen historical revision must not block unrelated work.

## Test Authoring And Completion

Test observable contracts with the cheapest meaningful deterministic regression. Keep fixtures small, isolated, content-safe and order-independent. Do not use `.only`, broad snapshots, permanent environment skips, real paid calls in ordinary suites, or unowned global cleanup. Cover affected loading/error/empty and lifecycle terminals.

Database, migration, prune, backup, reset and installation checks validate exact targets before mutation and clean only owned resources. Required live/runtime evidence cannot be replaced with a fake or prose assertion.

Before completion, perform root [final review](../AGENTS.md#before-final-response) and report exact passed checks and reasons for relevant omissions. Required-but-unavailable evidence leaves the affected work blocked.
