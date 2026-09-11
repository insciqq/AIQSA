# TESTING

Owns verification selection, target safety, external-call permission, and test authoring. Run the cheapest deterministic check that proves the increment, then the completion lane proportional to the changed boundary. Unrelated expensive lanes are not cumulative release requirements.

## Core Lanes

Install dependencies when needed with `npm ci`. During a task, run focused regressions and lint changed files. Select tests by affected behavior and consumers, not merely by changed test filenames. Cosmetic changes can use an existing browser check; do not create tests that only mirror an implementation.

| Change | Completion evidence |
| --- | --- |
| Documentation only | `npm run docs:check` |
| Deterministic task | Focused tests and changed-file lint |
| Integrated product-code slice | One `npm run check:hermetic` on the chosen local, remote, or CI executor; includes Prisma generation, docs, lint, types and deterministic tests |
| Verification/docs tooling | Focused tooling regressions and docs check; application tests only when their behavior is affected |
| Database, concurrency, process/service boundary | Affected disposable stateful/integration tests below |
| Browser/server routing, auth/session, streaming, geometry/input/focus | Focused components plus affected Playwright states |

The integrating agent owns the combined check; workers run focused checks only. Do not repeat a passing full suite on another executor or after a narrow correction: rerun the affected checks. Reuse evidence only while its source, dependencies, configuration and relevant generated inputs remain valid. Expand coverage for shared-boundary changes or a diagnosed failure, not for extra reassurance. Record a check's scope and result once in the task.

Run standalone types once at slice integration when the selected full check or imminent build does not already cover them. Preserve valid incremental caches. Stale generated `.next` types require fresh route types or a clean snapshot, not source changes to satisfy deleted routes. Full Hermetic remains available locally; [CI](../.github/workflows/ci.yml) runs it for PRs, explicit dispatch and full verification callers, without repeating it on every main push.

## Execution Target And Resources

Before heavy work, read root `DEV_SERVER.md` if it exists. It contains private operator-provided connection details and limits, never a public dependency. Prefer its server after a short noninteractive SSH/capacity preflight using the specified identity and verified host key. If absent, unreachable or missing required capacity/tools, report the reason briefly and use bounded local execution without another approval request.

A test failure is not executor unavailability. If an SSH connection is lost after work starts, check its owned job/status before retrying elsewhere; never duplicate an ambiguously running check. Export only an inspected Git commit/tree, including reviewed pending changes when applicable. Never copy the working directory, `.env`, SSH keys, `DEV_SERVER.md`, private tasks, profiles or production data. Use owned workspaces, unique disposable projects and synthetic state. Retain dependencies and valid compiler/build caches between slices; clean disposable test state and obsolete owned outputs, not reusable workspaces.

Run one heavy local process at a time. On the measured 16 GiB workstation, use a 6 GiB Node heap, 8 GiB process-group/container cap, four CPUs and no swap; require headroom for the host and stop if available RAM falls below 3 GiB. A Node heap flag alone is not a total memory limit. Keep build/browser/full-test work sequential and use one browser/stateful worker. Remote limits come from its private file; increasing resources never broadens verification scope.

Reuse one prepared disposable browser stand for the slice. After a repeated identical infrastructure failure, stop broad reruns, retain diagnostics and narrow the investigation. Unavailable required evidence remains explicit; a failed stand is not a passing check.

Read [Environment](ENV_VARIABLES.md) first. Preserve the checkout's configuration and operator profile; use a unique acknowledged disposable project for stateful work. Never target the persistent installation. Commands for the disposable topology:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
```

Full container parity deploys migrations and repeats deterministic plus stateful tests; reserve it for a full parity/release run or a change requiring that scope. Inside an already prepared acknowledged disposable app container, `npm run test:full:inner -- --project stateful <test-files>` selects only stateful tests; omit files for the complete stateful set. This avoids repeating Hermetic. `*.prisma.test.*` and `*.integration.test.*` are excluded from ordinary Hermetic.

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
| Publication | `npm run release:privacy:check`, an inspected-tree release build and image inspection on the selected local/remote/CI executor. Publication still needs explicit authority. |

Manual [Release full](../.github/workflows/release-full.yml) performs full verification and builds its own images through the [shared build](../.github/workflows/release-build.yml), then runs `node scripts/production-smoke.mjs --disposable <image-map.json>`. The smoke owns a fresh project and synthetic data, verifies initialization and image replacement with a forward migration, checks that credentials/settings/a chat survive repeated updates, and proves that a failed migration blocks the new app. Never substitute an existing installation for this target. This lane may upload images by digest and update build caches, but never updates release image tags or creates a GitHub Release. Build or installation changes still need their affected boundary checks; workflow routing changes use focused tooling checks.

An ordinary request to release an AIQSA version uses [Release](../.github/workflows/release.yml): stable and prerelease tags both default to build and publication. Reuse applicable slice evidence and retain the privacy, version and publication-integrity checks. A duplicate local release build, another full Hermetic/container/E2E run and installation smoke are not tag prerequisites; request full verification separately when needed. A successful tag workflow proves build and publication, not full regression. Numbered candidates (`vX.Y.Z-rc.N`) update versioned images and the separate `rc` channel only; unchanged infrastructure may reuse stable digests.

A request to verify ordinary work means its affected scope. Run the complete browser catalog or a broad theme/viewport matrix only for a change requiring that coverage or an explicitly selected full regression. Unrelated failures are recorded separately and do not silently expand the current slice.

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
