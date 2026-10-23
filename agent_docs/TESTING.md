---
paths:
  - "tests/**"
  - "playwright*.config.ts"
  - "vitest*.config.ts"
  - "vitest*.setup.ts"
  - "scripts/vitest-project-config.ts"
  - "scripts/smoke-*"
  - "scripts/*-smoke-support.ts"
  - "scripts/production-smoke.mjs"
  - ".github/workflows/**"
  - "benchmarks/**"
---
# Testing

How to choose checks, where to run them, which external calls are allowed, and how to write tests. Run the cheapest deterministic check that proves the change, then the completion check that matches the boundary you touched. Expensive lanes unrelated to the change are not required.

## Choosing checks

| Change | Evidence for completion |
| --- | --- |
| Documentation only | `npm run docs:check` |
| A single deterministic change | Focused tests and lint of the changed files |
| An integrated product-code slice | One `npm run check:hermetic` (Prisma generation, typegen, docs, lint, types, deterministic tests) |
| Verification or docs tooling | Its focused tests and `docs:check`; application tests only if their behavior changed |
| Database, concurrency, process or service boundary | The affected stateful tests on a disposable target (below) |
| Browser and server routing, auth and sessions, streaming, layout, input or focus | Focused component tests plus the affected Playwright states |
| Task ledger | `npm run task:check` and the ledger's focused tests |

- Pick tests by the behavior and consumers you changed, not by which test files you edited. Do not write tests that only mirror the implementation.
- When workers run in parallel, they run focused checks; the integrating agent runs the one combined check for the slice.
- Do not rerun a passing full suite on another machine or after a narrow fix; rerun what the fix affects. Evidence stays valid while its sources, dependencies, configuration and generated inputs are unchanged. Widen coverage for a shared boundary or a diagnosed failure, not for reassurance.
- Run `npx tsc --noEmit` once per slice when `check:hermetic` or an imminent build does not already cover types. Stale `.next` route types need regenerated types (`npx next typegen`) or a clean checkout, never source edits that satisfy deleted routes.
- CI (`.github/workflows/ci.yml`) runs Hermetic for pull requests and on explicit dispatch, not on every push to main.
- A request to "verify" ordinary work means its affected scope. Run the whole browser catalog or a broad theme and viewport matrix only when the change needs it or a full regression was asked for. Record unrelated failures separately; they do not widen the current work.

## Where to run heavy checks

- Read the root `DEV_SERVER.md` first if it exists. It is private machine configuration with a remote executor and its limits. Use that server after a short non-interactive SSH and capacity check. If the file is absent or the server is unreachable or lacks capacity, say why in one line and run locally within the limits below; no approval is needed for the fallback.
- A failing test is not an unavailable executor. If an SSH session drops mid-run, check the job you started before retrying anywhere; never run a second copy of a check that may still be running.
- Send only an inspected Git commit or tree to another machine (`git archive`), including reviewed uncommitted changes when needed. Never copy the working directory, `.env`, SSH keys, `DEV_SERVER.md`, task files, local profiles or production data.
- Locally, run one heavy process at a time. On the measured 16 GiB workstation that means a 6 GiB Node heap, an 8 GiB cap for the process group or container, four CPUs and no swap; stop if free memory drops below 3 GiB. A heap flag alone does not cap total memory. Keep builds, browser runs and full suites sequential with one browser or stateful worker.
- Reuse one prepared disposable browser stand per slice. After the same infrastructure failure repeats, stop rerunning, keep the diagnostics and narrow the investigation. A broken stand is not a passing check.

## Stateful and container checks

Read `agent_docs/ENV_VARIABLES.md` first, keep the checkout's configuration, and never target the persistent installation. The disposable topology:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
```

- `*.prisma.test.*` and `*.integration.test.*` files are excluded from Hermetic (`scripts/vitest-project-config.ts`). Inside an already prepared disposable app container, `npm run test:full:inner -- --project stateful <files>` runs only the stateful tests you name (omit files for all of them) without repeating Hermetic.
- Full container parity (`check:container`) deploys migrations and repeats deterministic and stateful tests; use it for a full parity or release run, or when the change needs that scope.
- Serialize stateful, container and browser-reset checks. Specs that reuse a server may overlap only if they reset nothing global. Put task-owned browser output in a fresh temporary directory and never delete another process's artifacts.
- Database, migration, prune, backup, reset and installation checks validate their exact target before mutating it and clean up only what they created.

## Extra evidence by boundary

| Changed boundary | Additional evidence |
| --- | --- |
| Schema, migrations, bootstrap | `npm run db:migration:smoke`; `npm run db:baseline:contract` for the baseline or custom PostgreSQL DDL. Disposable databases only. |
| Compose, images, installation | Focused config tests; disposable startup or bootstrap only when that behavior changed. Keep non-root roles and separate identities. |
| Backup, restore, destructive retention | Dry run first; real backup, empty-target restore or deletion only with explicit authority over a disposable or intended target. |
| UI | The affected states, themes, viewports, focus transitions and overflow (`agent_docs/FRONTEND.md`). Assert behavior and geometry, not screenshots or component structure. |
| Providers | Deterministic request, stream and parser tests with fakes first; real calls only as allowed below. |
| Dependencies | Focused hostile-input checks and `npm run security:deps` (plus `npm run security:deps:go` for `connect/`); review the manifest, lockfile, lifecycle scripts and overrides (`agent_docs/SECURITY.md`). |
| MCP and OAuth | Deterministic protocol and security tests, then the relevant disposable runtime. Hosted consent and upstream OAuth need their own authority. |
| Workspace and KVM | Policy, protocol and output tests, disposable database race checks, image builds, isolated browser flows, then opt-in real KVM evidence covering execution loss, Stop, runner restart, export and recovery, file integrity, network modes and cleanup. A fake runtime is never live evidence. |
| Upload parsers | Deterministic routing, bounds and decoders, then the disposable parser smoke; a stopped parser must degrade locally without breaking readiness. |
| Memory, recovery | Focused policy and handler tests, then disposable PostgreSQL with pgvector for persistence, concurrency and retrieval. Integrity and rebuild output stays content-free. |
| Publishing (push, PR) | `npm run release:privacy:check` and the root final review; reuse existing verification. Publishing still needs an explicit request. |

## Images and releases

- Commits and pushes need no extra builds. "Fresh readiness" means existing evidence covers the final diff.
- Build a production image (from an inspected Git export) only when image assembly or container startup changed: the Dockerfile or base image, build context or COPY rules, runtime installation, pruning or native dependencies, standalone bundling, entrypoints. Also for an image-only failure or an explicit request. Manifest or lockfile edits alone do not qualify; Compose-only changes need config and startup checks, not a rebuild.
- The manual Release full workflow (`.github/workflows/release-full.yml`) owns full verification, image builds and the production smoke (`scripts/production-smoke.mjs`) on fresh synthetic state. It never targets an existing installation and never creates tags or GitHub Releases. Use it only when full verification is explicitly requested.
- An ordinary release uses `.github/workflows/release.yml`. Reuse slice evidence plus privacy, version and publication checks; do not rerun image builds, Hermetic, container suites or installation smokes before tagging. A green release workflow proves build and publication, not regression.

## Real providers and opt-in checks

- Tests use fake providers. Never print keys, prompts, answers, source text or URLs, private identifiers, raw tool payloads or paths that carry capabilities. Evidence is limited to versions, stable codes, booleans, counts, latency, limits, hashes and cleanup results.
- Real provider calls (Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek, hosted Search, OAuth registries) need explicit permission for that provider and the smallest useful call. `smoke:custom-openai-compatible` is local and credential-free. `smoke:memory-semantic` may run against a loopback disposable app with credentials already stored through Admin.
- Read an opt-in script and its guards before running it; flags, fixtures, limits, cleanup and assertions belong to the script.
- Paid and live Workspace smokes (`smoke:workspace-live`, `smoke:workspace-user-paid`) need explicit disposable opt-in, real KVM and synthetic data; `smoke:memory-browser-paid` and `smoke:memory-mcp-codex` need explicit permission and their own disposable target. Diagnose a failure before any paid retry.
- An unexplained Personal Memory `DEGRADED` result fails a provider smoke, benchmark or qualification even when the answer is right. Find and fix the shared cause, or show that the scenario injected that fallback on purpose.
- Benchmarks are opt-in and outside product lint, types and tests. A benchmark that calls providers needs isolated disposable infrastructure, provider permission, frozen public datasets and content-free output.

## Writing tests

- Test observable behavior with the cheapest meaningful deterministic regression. Keep fixtures small, isolated, free of real content and independent of order. Cover the affected loading, error, empty and terminal states.
- No `.only`, broad snapshots, permanent environment skips, real paid calls in ordinary suites or cleanup of resources the test did not create.
- Keep scored corpora, relevance labels and large question sets out of co-located tests.
- Required live or runtime evidence cannot be replaced by a fake or by a written claim. If it cannot be obtained, the work stays blocked.
