# ADR

Architecture Decision Records capture durable product and technical decisions for AIQSA.

## Status Values

- `Accepted`: current decision.
- `Superseded`: replaced by a later ADR.
- `Proposed`: not yet binding.

Every ADR also declares `Amends: none` or a comma-separated list of earlier ADR filename stems. `Amends` records a partial decision edge and does not imply that the target is fully superseded; prose in both ADRs defines the exact clause that changed.

## Accepted ADRs

- `0001-product-direction-qsa.md` - AIQSA is a QSA product; search, provider controls, events, and branch state are core surfaces, while ADR 0009 supersedes its fixed dense three-pane presentation.
- `0002-technical-stack-nextjs-docker-postgres.md` - the app is one TypeScript/Next.js/Postgres/Docker Compose system with provider calls behind internal adapters.
- `0003-autonomous-agent-delivery.md` - delivery uses `AGENTS.md`, `AUTONOMOUS_WORKFLOW.md`, active task specs, done notes, and ADRs.
- `0004-private-auth-entitlements-uploads-and-sharing.md` - auth, entitlements, upload privacy, search strategies, and sanitized share snapshots are early foundations.
- `0005-in-process-run-cancellation-and-active-run-gate.md` - current runtime uses in-process cancellation plus a database-backed per-chat active-run guard.
- `0006-custom-safe-markdown-renderer.md` - assistant/share markdown uses the local safe renderer; ordinary Markdown stays in React text nodes and highlighted fenced code trusts only reviewed Shiki output.
- `0007-context-window-budget-and-trimming.md` - provider context replay is server-owned and trimmed deterministically before run creation; ADR 0017 amends its text-estimate rule.
- `0008-multi-user-auth-direction.md` - multi-user auth uses email/password plus optional Google/Yandex OAuth, same-email identity merge, verified access requests, approval gates, and stateful sessions.
- `0009-conversation-first-ui-revamp.md` - the UI becomes conversation-first while preserving every QSA, provider, search, inspection, organization, auth, and admin capability; ADR 0025 now owns the clean-slate presentation and first-use direction.
- `0010-neutral-light-theme.md` - themes declare dark/light scheme metadata and retain five original stable IDs; ADR 0025 changes no-preference first use to `neutral`, and ADR 0027 appends `paper` without changing the original ids.
- `0011-explicit-next-run-control-ownership.md` - chats move from row menus, users select concrete models rather than providers, Reasoning is direct, Run settings owns next-run editing, and Details owns Branch/Events inspection.
- `0015-lean-local-development-harness.md` - routine work uses one Compose check and an explicit destructive local E2E path; local CI, isolation/recovery, pollution cleanup, receipts, galleries, and parallel orchestration are intentionally absent.
- `0016-responsive-composer-disclosure.md` - establishes exact responsive next-run disclosure and accessibility outcomes; ADR 0025 replaces its fixed compact composition and scroll-collapse recipes with one adaptive resting composer.
- `0017-conservative-multilingual-context-estimates.md` - context admission uses a dependency-free conservative Unicode estimate, exposes the safe input budget separately from total context, and keeps runtime attachment/tool re-budgeting.
- `0018-intent-gated-mobile-reading-mode.md` - preserves blank-workspace, focus, Stop, and compact-access outcomes; ADR 0025 retires its fixed rail and scroll-intent composer-collapse presentation.
- `0019-safe-katex-math-rendering.md` - the custom Markdown parser recognizes common TeX delimiters and sends only restricted untrusted expressions through locally bundled KaTeX; failed math stays escaped React text.
- `0020-unified-installation-and-isolated-development.md` - the default Compose path is one persistent install/update topology with canonical environment names, while deterministic seed/Fake QSA checks use a separate disposable development stack.
- `0021-admin-managed-mcp-tools-and-isolated-runtime.md` - administrators own and grant trusted revisioned MCP servers as whole tool sets; users persistently enable entitled servers, fill only explicitly permitted personal-value slots, and may authorize declared remote OAuth connections such as Notion, while AIQSA reuses its provider-neutral foreground/background parallel tool loop, uses the official MCP SDK for direct remote and ToolHive-proxied sessions, and uses ToolHive only to isolate local executable MCP.
- `0022-admin-managed-llm-provider-control-plane.md` - Postgres owns administrator-managed LLM connections/models, explicit Responses/Chat adapter kinds, immutable encrypted credential versions, priority-free group credential assignments, one activation-time catalog check per referenced key, and exact answer/search run snapshots; infrastructure roots and safety limits remain in env and direct-user assignment remains a future resolver extension.
- `0023-admin-managed-runtime-smtp-configuration.md` - one optional installation SMTP channel uses a singleton draft/active lifecycle with exact-draft testing, write-only encrypted credentials, strict TLS/network policy, consistent per-send resolution, preserved auth outcomes, and one stopped full cutover from environment ownership without revision or drain machinery.
- `0024-admin-managed-run-profiles.md` - Fast, Balanced, and Deep are three fixed database-owned semantic slots that administrators atomically map to active stable deployment IDs and supported reasoning tuples; the entitlement-filtered user catalog is their only composer projection and never leaks unavailable targets.
- `0025-clean-slate-research-chat-and-control-center.md` - the view layer is replaced in place by light-first Research Chat and Control Center surfaces with adaptive composition, evidence-backed Run receipts, complete parity, preserved runtime ownership, and mandatory legacy deletion.
- `0026-personal-provider-quick-setup.md` - one canonical OpenAI, Anthropic, or OpenRouter answer deployment becomes usable for the acting administrator through one write-only key, exact versioned recommendation/picker policy, and fenced atomic save; replacement preserves that selected model, groups remain untouched, and the Advanced control plane stays lazy and complete.
- `0027-paper-light-theme.md` - appends a sixth stable light `paper` palette with a soft monochrome, conversation-product-familiar hierarchy while preserving the five existing themes and the `neutral` default.

## Superseded ADRs

- `0012-crash-recoverable-verification-resources.md` - superseded by ADR 0015; historical crash-recoverable verification design.
- `0013-parallel-browser-verification-namespaces.md` - superseded by ADR 0015; historical invocation-isolation design.
- `0014-provenance-bound-local-pollution-cleanup.md` - superseded by ADR 0015; historical local-pollution cleanup design.

Read this index before work that may change an accepted product or architecture decision. Read the full ADRs for the affected area, and all accepted ADRs only before broad architecture work. Add a new ADR only when making or changing a durable decision.
