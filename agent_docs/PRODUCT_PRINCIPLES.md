# PRODUCT_PRINCIPLES

Owner: Product direction
Scope: Stable product intent and prioritization guidance that informs implementation choices without replacing safety invariants or executable contracts.
Verified against: 4f51fdd (2026-08-01)

## Direction

- AIQSA is a self-hosted Question → Search → Answer product for a small 50+ user installation. It is not an agent builder, plugin marketplace, workflow canvas, or generic tool-authoring product.
- The primary experience is a conversation-first Research Chat with explicit provider, model, Search, prompt, and run control. Control Center exists to make those runtime choices administratively truthful and available, not to become the product's main surface.
- Transparency is a product capability: users can inspect branches, normalized run evidence, Search/tool activity, citations, status, and usage without turning inspection into a second next-run editor.
- Current capabilities stay reachable through one presentation and one state owner. New visual treatments do not justify parallel classic/new applications, duplicate API clients, hidden fallback renderers, or invented product state.
- Server-owned trust is visible rather than implied. Unavailable, unknown, pending, failed, revoked, and disabled facts remain distinct; the UI does not manufacture success, cost, readiness, entitlement, or audit evidence.
- Progressive disclosure protects the reading flow while preserving complete access to setup and evidence. Conversation and composer remain primary; Workspace, Details, Settings, and administrative tasks appear when their object and authority exist.
- The first-use palette is light `neutral`; all supported stored theme ids remain compatible and present the same semantic hierarchy. Visual specifics belong to `DESIGN_SYSTEM.md`.
- Dedicated WCAG conformance work remains explicitly deferred, but responsive access, keyboard-safe text entry, touch operation, readable overflow, and focus-safe existing interactions remain current behavior contracts.

## Decision Use

When several safe implementations satisfy the current contract, prefer the smallest one that preserves explicit user control, truthful evidence, private-by-default data handling, and a runnable self-hosted installation. `CRITICAL_INVARIANTS.md` wins on safety; accepted ADRs win on durable decisions; the bounded backend/frontend owners define current behavior.
