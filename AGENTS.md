# AIQSA

AIQSA is an open-source (AGPL), self-hosted, multi-user, model-agnostic conversational workspace. Chat is the product; administration exists to make providers, models, Search, Knowledge (document retrieval), Personal Memory, Assistants, Skills, MCP tools, the sandboxed Workspace, scheduled tasks and artifacts available and trustworthy. Coding agents write all of the code; the operator sets scope and makes product decisions. Real installations run in production, so upgrades must keep working.

Stack: Next.js 16 (App Router), React 19, TypeScript, Prisma 6 on PostgreSQL with pgvector, OpenSearch as a rebuildable search index, S3-compatible private object storage, parser sidecars, a KVM Microsandbox Workspace runner, and single-host Docker Compose. `connect/` is a separate Go client.

## Repository map

- `app/` holds pages and routes; `app/api/` handlers stay thin and call into `lib/server/`.
- `lib/contracts/` holds client-safe wire shapes and is a dependency leaf; `lib/domain/` holds pure shared rules; `lib/browser/` holds browser-only helpers.
- `lib/server/` holds everything server-only: repositories, providers, the run pipeline (`runs/`), `memory/`, `knowledge/`, `mcp/`, `workspace/`, `auth/` and the rest.
- `features/` and `components/` hold the browser UI.
- `prisma/` holds the schema, append-only migrations and bootstrap; `ops/` holds companion image builds; `scripts/` holds tooling, smokes and the task ledger; `tests/` holds end-to-end and integration suites; `benchmarks/` is opt-in.

Browser code never imports server modules, Prisma, secrets, Node-only APIs or provider transports. ESLint enforces the import direction (`scripts/eslint/architecture-boundaries.mjs`).

## Commands

```bash
npm ci && npm run db:generate && npx next typegen   # fresh checkout
npx vitest run <files>                              # focused tests
node node_modules/eslint/bin/eslint.js --max-warnings=0 --no-cache <files>   # lint changed files
npx tsc --noEmit
npm run check:hermetic   # full deterministic gate: prisma generate, typegen, docs, lint, types, vitest
npm run docs:check       # links and size budgets of agent docs
npm run task:check       # after any task ledger change
```

`npm run lint` lints the whole repository and takes 10–17 minutes; leave it to `check:hermetic`. Stateful, browser, container and paid checks are described in [Testing](agent_docs/TESTING.md).

## How to work

- An implementation request is permission to proceed. Same-session work needs no task file. Queued, multi-session or parallel work goes through the [task ledger](agent_docs/tasks/README.md).
- Run `git status --short` before editing and preserve changes you did not make.
- Before changing an area, read its document from the table below. Claude Code loads it automatically when you open a matching file (the documents carry `paths:` globs and are symlinked from `.claude/rules/`); other agents read it from the table.
- Make the smallest complete change, verify it in proportion to what it touches ([Testing](agent_docs/TESTING.md)), and finish it yourself: there is no human review gate. If required evidence cannot be obtained, the work stays blocked; say so.
- Stop and ask only for missing secrets or authority, destructive work nobody requested, a required service that is unavailable, or a product decision the existing contracts do not cover.

| When you change | Read |
| --- | --- |
| Routes, API handlers, uploads, exports, shares, admin control planes (Assistants, Skills, MCP servers) | [Backend](agent_docs/BACKEND.md) |
| Deployment shape, services, dependency direction, any new external destination | [Architecture](agent_docs/ARCHITECTURE.md) |
| Prisma schema, migrations, retention, deletion, backup and restore | [Persistence](agent_docs/PERSISTENCE.md) |
| Provider adapters, model roles, capability checks, Search, embeddings, reranking, prices | [Providers](agent_docs/PROVIDERS.md) |
| Personal Memory | [Memory](agent_docs/MEMORY.md) |
| The run pipeline: admission, context and compaction, tools, Knowledge answers, MCP tool loop, Workspace and Agent runs, scheduled tasks, Telegram, recovery, outputs | [Run contracts](agent_docs/RUN_CONTRACTS.md) |
| UI behavior and visual design | [Frontend](agent_docs/FRONTEND.md) |
| Sessions, secrets, untrusted content, MCP trust, the Workspace sandbox, artifacts, dependencies | [Security](agent_docs/SECURITY.md) |
| External sign-in, SCIM, two-factor sign-in | [Sign-in](agent_docs/SIGN_IN.md) |
| Environment variables, Compose selection, key rotation | [Environment](agent_docs/ENV_VARIABLES.md) |
| Tests and verification, smokes, releases | [Testing](agent_docs/TESTING.md) |

## Rules that hold everywhere

These are the invariants most likely to be broken by an otherwise reasonable change. The area documents explain the details.

- **Authorize at the operation.** Every read or write of a private resource authenticates and checks ownership, entitlement and lifecycle where it happens, not only at the page. Administrator status does not open other users' private Assistants or Knowledge. A resource the caller cannot see and one that does not exist get the same response, so responses leak nothing.
- **The server decides.** Controls resolve from the current user's server-filtered catalog and are rechecked before a run is admitted and again before external dispatch. The browser, a model, a tool result or a stored reference can never grant entitlement, pick a target the user cannot use, or authorize a mutation.
- **No silent substitution.** When a chosen provider, model, credential, route or destination is unavailable, fail visibly. Never fall back to something the user or administrator did not choose, and keep "not set", explicit Off and a concrete choice distinct.
- **Accepted runs are frozen.** Configuration changes affect future messages only. An accepted run keeps its exact bindings, identity, outputs and recovery evidence; editing a message branches the conversation; terminal persistence has exactly one guarded winner.
- **Never repeat an external side effect.** Record a durable dispatch identity before external I/O. An operation whose outcome is unknown is never replayed, and recovery never repeats settled or crash-ambiguous work. Usage and cost come only from provider-reported accounting; unknown stays unknown and is never estimated from text length.
- **Private by default.** Attachments, Knowledge originals, user text, queries, evidence and internal identifiers stay private. Browsers receive only explicit, reviewed projections. Logs are content-free. Store raw request or response bodies only when execution, recovery, safety or accounting needs them; being useful for debugging is not enough.
- **Projects are isolated.** Project runs use only Project and shared resources, never a member's personal credentials, Memory, chat history, unpublished Skills, OAuth identity or personal MCP values.
- **Untrusted input is bounded first.** Validate and bound route, provider, tool and file input before any mutation or external I/O. Provider and storage SDKs and all secrets stay on the server.
- **Models do not mutate on their own.** A model may change user data only through the operator's listed exceptions (scheduled tasks and Skill saves in personal chats, MCP calls the user approved); see [Run contracts](agent_docs/RUN_CONTRACTS.md) and [Security](agent_docs/SECURITY.md).
- **Nothing new leaves the installation implicitly.** A new external destination, credential audience, public projection or durable store needs its privacy, failure, retention and operator story written down in [Architecture](agent_docs/ARCHITECTURE.md) first.

## Product stance

- Answers show content, sources, generated files, factual progress and actionable failures. Inspecting internal execution (raw payloads, scores, event histories) is not a product goal: do not build diagnostic views, and delete diagnostics nobody uses together with the data that only fed them.
- Keep a modular monolith. Add a service, runtime, library or abstraction only for an observed limitation or real duplication. Prefer the smallest complete change that keeps a self-hosted installation runnable.
- Extend existing conversation, provider, tool, entitlement and run contracts instead of creating parallel ones. Never present planned capabilities as shipped.
- Installations upgrade with `docker compose pull && docker compose up -d`. Persisted data, the chat export format, environment variables, URLs and backups are compatibility contracts; breaking one needs an explicit operator decision ([Persistence](agent_docs/PERSISTENCE.md#migrations-and-bootstrap)). Development databases, fixtures and local task files are not contracts.

## Data, environment and secrets

- Never reset, migrate, seed, prune or otherwise touch the persistent installation (`compose.yaml` and its volumes) or operator data during development. Stateful checks use the disposable `docker-compose.dev.yml` stack or another explicitly disposable target and clean up only what they created. See [Environment](agent_docs/ENV_VARIABLES.md) before running Compose.
- Never print `.env`, resolved environments, keys or tokens; report presence and validity instead.
- Provider calls in tests are fake. Real provider calls need the permission described in [Testing](agent_docs/TESTING.md).

## Git and publication

`origin` is public. `DEV_SERVER.md`, `AGENTS.override.md`, `CLAUDE.local.md`, `.claude/agents/`, `.aiqsa/`, `agent_docs/PRD/` and task files under `agent_docs/tasks/` are private: never stage, force-add, commit or ship them in Docker contexts or images. Pushes, ref rewrites and release tags need an explicit request and a fresh `npm run release:privacy:check`. To export code, `git archive` an inspected commit into a fresh directory; never copy the working directory.

## Writing agent docs

Code, schema, migrations and tests define behavior. The documents in `agent_docs/` record only what an agent cannot recover from the code and would otherwise get wrong: operator decisions (with their date), accepted risks, invariants with their reasons, and boundaries between subsystems. Do not mirror code (constants, limits, field lists, step-by-step flows); point to the file instead. Keep each rule in one place and link to it. When a document grows past its budget, delete what the code already says rather than compressing the prose. If code contradicts a documented rule, fix the code unless the operator changes the rule.

Write plain sentences and cite code by repository path in backticks. A new area document needs `paths:` frontmatter, a symlink in `.claude/rules/` and an entry in `scripts/docs-manifest.mjs`; `npm run docs:check` verifies the globs, the symlinks, cited paths and size budgets. Add to an existing document before creating a new one.

## Before you report

1. Compare `git status --short` with the starting state; run `git diff --check` and `git diff --cached --check`.
2. Read the whole diff of every file you touched, including new files.
3. Remove unrelated changes, secrets or private values, build and log artifacts, and generated drift. Keep and mention pre-existing user changes.
4. Report the outcome, material decisions, the exact checks you ran, relevant checks you skipped and why, and anything still blocked.
