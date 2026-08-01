# ADR 0053: Bounded Agent Context And Split Verification Lanes

Status: Accepted
Amends: 0003, 0015

## Context

The root agent entry point remained compact, but the mandatory subject reads did not. `FRONTEND.md` and `BACKEND.md` had grown into 142 KB and 99 KB monoliths, and `CRITICAL_INVARIANTS.md` mixed privacy/data rules with pixel-level interaction geometry. Empty `.agents/` and `.codex` placeholders conveyed no shared intent. The one routine Compose check also made a database/container stack the default completion cost for documentation, pure-domain, component-unit, and deterministic adapter work.

The repository needs reproducible instruction discovery and parity evidence without loading unrelated contracts or weakening stateful integration coverage.

## Decision

- Root `AGENTS.md` remains the global workflow/router. Only `lib/server/`, `components/`, `prisma/`, and `ops/` gain concise nearest-scope `AGENTS.md` files. Docs check enforces each nested budget and the combined root-plus-nearest discovery budget; nested files route to subject owners instead of copying root autonomy, publication, or completion rules.
- `CRITICAL_INVARIANTS.md` contains only data loss, security/privacy, incompatible persisted state, destructive verification, and key QSA semantics. `PRODUCT_PRINCIPLES.md` owns stable direction. `FRONTEND.md` and `BACKEND.md` become short reading maps to bounded current-contract documents; `DESIGN_SYSTEM.md` owns visual recipes, generated reference owns route/schema inventory, and accepted ADRs/archive own history.
- Large living documents declare an owner, bounded scope, and manually reviewed commit/date. Docs check reports missing, invalid, future, or older-than-120-day markers and never rewrites them.
- `agent_docs/generated/API_AND_SCHEMA.md` is deterministically generated from route exports and Prisma model/enum declarations. Docs check reports drift; regeneration is explicit and reviewed.
- A clean checkout uses `npm ci`. `npm run check:hermetic` runs generation, docs, lint, types, and every non-database/non-integration Vitest case without Docker, network, secrets, or `DATABASE_URL`. Direct Prisma-singleton tests are explicitly classified and guarded against drift.
- `npm run check:container` remains the disposable Compose parity lane and runs the complete existing `npm run check`, including PostgreSQL-backed cases. Migrations, browser integration, ToolHive, providers, and other external boundaries remain explicit task-specific lanes.
- The repository retains no owned `.agents/` directory or `.codex` placeholder. Agent runtimes may mount ignored ephemeral paths with those names while a session is active; those mounts are not shared instructions or repository artifacts. Plugin/agent state is never inferred from them.

## Consequences

- An agent reads root instructions plus one small nearest domain file and only the routed contract needed for its change.
- Current behavior remains preserved verbatim across bounded subject documents while critical privacy/data rules become visible in a short mandatory read.
- Minor deterministic changes can finish with reproducible host-local evidence; stateful boundaries still require disposable container parity rather than being silently skipped.
- Verification dates become deliberate review work. Passing checks cannot claim that a large contract was reverified automatically.
