# PRODUCT_PRINCIPLES

Owner: Product direction
Scope: Stable product intent and prioritization guidance that informs implementation choices without replacing safety invariants or executable contracts.

## Direction

- AIQSA is a self-hosted, multi-user AI workspace for small operator-managed installations. It brings multiple LLM providers, MCP tools, optional web search, prompts, files, and conversation history into one interface.
- The primary experience is conversation-first Chat with explicit provider, model, Search, prompt, tool, and run control. Control Center exists to make those runtime choices administratively truthful and available, not to become the product's main surface.
- Search, citations, and run evidence are important capabilities, not the identity of the product. Public copy must not decode AIQSA into a staged acronym or frame the application as a research-only tool.
- Agents may become first-class task and runtime objects. Shipped product copy must distinguish current capabilities from planned work, and agent implementation should extend the existing provider, tool, entitlement, conversation, and run contracts rather than create a disconnected low-code workflow product.
- Transparency is a product capability: users can inspect branches, normalized run evidence, Search and tool activity, citations, status, and usage without turning inspection into a second next-run editor.
- Current capabilities stay reachable through one presentation and one state owner. New visual treatments do not justify parallel classic/new applications, duplicate API clients, hidden fallback renderers, or invented product state.
- Server-owned trust is visible rather than implied. Unavailable, unknown, pending, failed, revoked, and disabled facts remain distinct; the UI does not manufacture success, cost, readiness, entitlement, or audit evidence.
- Progressive disclosure protects the reading flow while preserving complete access to setup and evidence. Conversation and composer remain primary; Workspace, Details, Settings, and administrative tasks appear when their object and authority exist.
- The first-use palette is light `neutral`; all supported stored theme ids remain compatible and present the same semantic hierarchy. Visual specifics belong to `DESIGN_SYSTEM.md`.
- Dedicated WCAG conformance work remains explicitly deferred, but responsive access, keyboard-safe text entry, touch operation, readable overflow, and focus-safe existing interactions remain current behavior contracts.

## Decision Use

When several safe implementations satisfy the current contract, prefer the smallest one that preserves explicit user control, truthful evidence, private-by-default data handling, and a runnable self-hosted installation. `CRITICAL_INVARIANTS.md` wins on safety, and the bounded backend/frontend owners define current behavior. An explicit task may change that behavior only when the owning contract changes with it.
