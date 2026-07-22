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
- `0009-conversation-first-ui-revamp.md` - the UI becomes conversation-first while preserving every QSA, provider, search, inspection, organization, auth, and admin capability; the fixed permanent three-pane presentation is superseded.
- `0010-neutral-light-theme.md` - themes declare dark/light scheme metadata; additive `neutral` / `Classic Light` and `classic-dark` / `Classic Dark` palettes join without changing the default or copying TypingMind's product layout.
- `0011-explicit-next-run-control-ownership.md` - chats move from row menus, users select concrete models rather than providers, Reasoning is direct, Run settings owns next-run editing, and Details owns Branch/Events inspection.
- `0015-lean-local-development-harness.md` - routine work uses one Compose check and an explicit destructive local E2E path; local CI, isolation/recovery, pollution cleanup, receipts, galleries, and parallel orchestration are intentionally absent.
- `0016-responsive-composer-disclosure.md` - below `sm`, direct compact profiles plus a text-backed Run summary and one Run setup sheet preserve explicit Model/Profile/Reasoning/Search state without the permanent multi-row phone control stack.
- `0017-conservative-multilingual-context-estimates.md` - context admission uses a dependency-free conservative Unicode estimate, exposes the safe input budget separately from total context, and keeps runtime attachment/tool re-budgeting.
- `0018-intent-gated-mobile-reading-mode.md` - compact chat chrome uses one application rail with direct Workspace/New chat access, while recent deliberate reading scroll in either direction may collapse idle Run/profile controls without hiding Message or an addressable Stop action; completed-tap expansion prevents Run click-through.
- `0019-safe-katex-math-rendering.md` - the custom Markdown parser recognizes common TeX delimiters and sends only restricted untrusted expressions through locally bundled KaTeX; failed math stays escaped React text.
- `0020-unified-installation-and-isolated-development.md` - the default Compose path is one persistent install/update topology with canonical environment names, while deterministic seed/Fake QSA checks use a separate disposable development stack.

## Superseded ADRs

- `0012-crash-recoverable-verification-resources.md` - superseded by ADR 0015; historical crash-recoverable verification design.
- `0013-parallel-browser-verification-namespaces.md` - superseded by ADR 0015; historical invocation-isolation design.
- `0014-provenance-bound-local-pollution-cleanup.md` - superseded by ADR 0015; historical local-pollution cleanup design.

Agents should read this index before implementation. Read the full ADR before changing work in its area, and read all accepted ADRs before broad architecture work. Add a new ADR only when making or changing a durable architectural decision.
