# AI_CONTEXT

## Purpose

This is the compact orientation and reading router for AIQSA. It does not duplicate subject contracts.

AIQSA is a self-hosted, multi-user QSA web app:

```text
Question -> Search -> Answer
```

The shipped product is a conversation-first workspace for explicit provider/model/search control, branchable chats, transparent run inspection, private attachments, and sanitized public snapshots. The target is a small installation of 50+ users. Exact behavior and visual rules live in the owners below.

## Current Stack

- TypeScript/Node.js with Next.js App Router and Route Handlers.
- React, Tailwind CSS, Zustand, and `lucide-react` in the browser.
- Postgres/Prisma plus S3-compatible storage, local MinIO, and a filesystem fallback.
- Fake, native/compatible OpenAI Responses, generic Custom-compatible Chat Completions, native Gemini Interactions v1, Anthropic Messages, and OpenRouter adapters behind database-resolved server-only provider contracts.
- Administrator-managed remote and local MCP servers through the official SDK, with ToolHive-isolated local workloads.
- Default Docker Compose for the persistent installation; `docker-compose.dev.yml`, Vitest, Testing Library, and Playwright CLI for isolated development verification.

## Runtime Shape

1. DB-backed session auth resolves the current active user.
2. The browser loads the entitled catalog and lightweight workspace summaries, then lazily loads the active thread.
3. The browser submits the current message, attachment ids, and next-run controls; it never supplies trusted prior-turn context.
4. The server validates ownership, entitlements, controls, context budget, and attachments before selecting provider/tool boundaries.
5. Provider-specific results become normalized events, persisted run/message/usage state, and a transient foreground thread/summary update.
6. Branch operations change a message DAG; sharing creates an immutable sanitized snapshot rather than exposing live private state.

## Living Contract Ownership

| Owner | Current contract |
| --- | --- |
| `CRITICAL_INVARIANTS.md` | Durable product, privacy, backend, frontend, and agent-development invariants. |
| `ADR/` | Why accepted architectural/product decisions were made and which earlier decisions they amend. |
| `ARCHITECTURE.md` | Process topology, module dependency direction, data boundaries, and deployment shape. |
| `BACKEND.md` | Observable API semantics, persistence constraints, run lifecycle, uploads, and internal adapter behavior. |
| `QSA_PIPELINE.md` | Product-level Question/Search/Answer stages, search behavior, transparency, and sharing semantics. |
| `FRONTEND.md` | UI capability, behavior, state ownership, responsive composition, and admin workflows. WCAG and dedicated accessibility work are deferred by operator decision. |
| `DESIGN_SYSTEM.md` | Palette/tokens, typography, geometry, density, visual hierarchy, and visual recipes. |
| `SECURITY.md` | Auth/threat boundaries, origin/session hardening, secret/exposure rules, and dependency-security policy. |
| `ENV_VARIABLES.md` | Complete environment inventory, defaults, switch semantics, and installation configuration. |
| `PROVIDER_API_NOTES.md` | Official provider references, externally mutable constraints, one last-verified marker per boundary, and provider-specific caveats. |
| `TESTING.md` | Focused iteration, the one routine Compose check, destructive local E2E, task-specific checks, and test-authoring rules. |

Workflow/default/task ownership remains with `AUTONOMOUS_WORKFLOW.md`, `DECISION_DEFAULTS.md`, `active_tasks/`, `backlog/`, and the local ignored `done_tasks/` journal. `ARCHITECTURE.md` includes the small semantic ownership map; repository structure is discovered from the tree rather than duplicated in a generated FILEMAP.

## Data Cautions

Catalog model names, prices, and context windows are operational metadata, not billing authority. Privacy/storage rules come from `CRITICAL_INVARIANTS.md` and `SECURITY.md`; data shape and retention semantics come from `BACKEND.md`.
