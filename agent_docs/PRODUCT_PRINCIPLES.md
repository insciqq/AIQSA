# PRODUCT_PRINCIPLES

Owner: Product direction
Scope: Stable product intent and prioritization guidance that informs implementation choices without replacing safety invariants or executable contracts.

## Direction

- AIQSA is an open-source, self-hosted, multi-user, model-agnostic web interface for working with LLMs. It brings provider and model choice, MCP tools, optional web search, Knowledge, Memory, prompts, files, and conversation history into one application.
- The primary experience is conversation-first Chat with explicit provider, model, Search, Knowledge, Assistant, tool, and run controls. Control Center makes those choices administratively truthful and available; it is not the main product surface.
- AIQSA is not a research workbench, run debugger, trace viewer, or forensic receipt product. Public copy and ordinary UI must not make post-hoc inspection part of the product identity.
- A completed answer exposes the result and user-relevant outputs: answer content, citations and a simple Sources disclosure when sources exist, generated files, normal message actions, and explicit confirmations for user-approved tool or Memory mutations. A live answer exposes factual progress, Stop, actionable failures, Retry, and recovery controls.
- Search attempts, generated queries, provider operations, Knowledge scores and thresholds, request previews, accepted-parameter receipts, post-hoc tool arguments/results, event timelines, and per-answer usage breakdowns are not ordinary product surfaces.
- Branches are conversation history and navigation. They remain directly reachable as a temporary Branches surface and are never modeled as an inspection tab or generic Details mode.
- Internal run records are purpose-bound to execution, durable recovery, prevention of duplicate external side effects, privacy/security, retention, and aggregate usage accounting. The existence of an internal record does not create a browser contract or a user-facing surface.
- Agents may become first-class task and runtime objects. Shipped copy must distinguish current capabilities from planned work, and agent implementation should extend the existing provider, tool, entitlement, conversation, and run contracts rather than create a disconnected low-code workflow product.
- Current capabilities stay reachable through one presentation and one state owner. New visual treatments do not justify parallel classic/new applications, duplicate API clients, hidden fallback renderers, or invented product state.
- Server-owned trust is visible where it affects action. Unavailable, unknown, pending, failed, revoked, and disabled facts remain distinct; the UI does not manufacture success, cost, readiness, entitlement, or completion.
- Progressive disclosure protects the reading flow and next-run setup. It is not a reason to retain a hidden run inspector after the underlying user need has disappeared.
- The first-use palette is light `neutral`; all supported stored theme ids remain compatible and present the same semantic hierarchy. Visual specifics belong to the bounded owners routed by `DESIGN_SYSTEM.md`.
- Dedicated WCAG conformance work remains explicitly deferred, but responsive access, keyboard-safe text entry, touch operation, readable overflow, and focus-safe existing interactions remain current behavior contracts.

## Decision Use

When several safe implementations satisfy the current contract, prefer the smallest one that preserves explicit user control, reliable outputs, private-by-default data handling, and a runnable self-hosted installation. Remove unused diagnostic UI and its supporting projections instead of retaining them behind a permanent feature flag. Keep only internal data with a demonstrated operational, safety, retention, or accounting consumer. `CRITICAL_INVARIANTS.md` wins on safety, and the bounded backend/frontend owners define current behavior. An explicit task may change that behavior only when the owning contract changes with it.
