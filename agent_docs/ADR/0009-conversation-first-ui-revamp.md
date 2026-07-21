# ADR 0009: Conversation-First UI Revamp Preserves QSA Capability

Status: Accepted
Amends: 0001-product-direction-qsa

## Context

AIQSA's functional core is substantially complete: users can organize saved chats and folders, choose entitled providers/models/search strategies, ask questions, inspect search and run events, branch conversations, manage prompt presets, attach files, and share sanitized snapshots.

The shipped UI exposes those capabilities, but the default hierarchy treats chat history, run controls, inspection data, and the conversation as peers. A 2026-07-10 screenshot audit at desktop and mobile widths found a paradoxical result: large empty reading surfaces surrounded by dense, permanently visible chrome. The fixed three-pane shell, multi-row composer controls, small technical labels, and border-heavy recipes make the product read as an internal operations console rather than an everyday QSA workspace.

The operator has approved a UI/UX revamp and delegated taste-level implementation decisions to the autonomous agent workflow. Product capability and backend behavior are not being reopened.

## Decision

AIQSA becomes a conversation-first, dark-first QSA workspace.

1. **Conversation is the default focus.** The current question, answer, and composer own the primary visual hierarchy. Navigation and inspection support that loop instead of competing with it.
2. **Desktop is not permanently three-pane.** The normal desktop workspace consists of chat/folder navigation plus the conversation. Details remains fully available on demand as a right-side drawer or sheet and may be pinned on sufficiently wide screens, but it does not consume reading width by default.
3. **The composer is one coherent surface.** Asking and sending are visually primary. Model and search remain immediately legible. Prompt, reasoning, background/streaming behavior, citations/reasoning visibility, notification sound, temperature, token limits, attachments, context estimates, and usage remain available through clear progressive disclosure.
4. **Capability parity is mandatory.** The revamp must not remove provider/model/search selection, prompt presets, run parameters, events, branch checkout, message actions, citations/reasoning, usage, sharing, folders/projects, keyboard workflows, auth flows, admin operations, or mobile access. Presentation defaults and disclosure behavior may change; storage, provider, run, ownership, and entitlement contracts do not.
5. **Power-user does not mean permanently dense.** Fast switching, keyboard access, transparency, and inspectability remain first-class. Density is applied where scanning benefits from it, while reading, composing, onboarding, and destructive decisions receive space and hierarchy.
6. **Visual identity is restrained but not mechanical.** Keep the dark palettes, Golos Text/JetBrains Mono pairing, one brand accent, semantic status colors, safe markdown, and reduced-motion support. Replace the legacy border grid, pervasive micro-labels, tiny controls, and terminal/trading-console framing with a calmer layered surface system, clearer typography, and fewer simultaneous emphasis cues.
7. **No clone target.** TypingMind and chatgpt.com remain workflow references, not visual specifications. AIQSA should be recognizable through its provider/search transparency and QSA run language without making the pipeline indicator decorative chrome at idle.
8. **Observable checks drive completion.** Visual slices receive focused behavior/accessibility coverage and direct inspection of the affected desktop/mobile states. Exhaustive generated screenshot galleries are not required.

## Transition

The ordered UI program was completed through tasks 175-200 and is preserved in `agent_docs/done_tasks/`. `agent_docs/FRONTEND.md` and `agent_docs/DESIGN_SYSTEM.md` now describe the shipped runtime; this ADR records the durable direction rather than an active transition queue.

ADR 0009 supersedes only the fixed dense three-pane and terminal/trading-console UI clauses of ADR 0001. The Question -> Search -> Answer product direction and all other accepted ADRs remain in force.

## Consequences

- The UI revamp can be completed without schema, route, provider-adapter, or QSA pipeline redesign.
- Existing view modules and state stores remain behavior boundaries; visual slices should not migrate backend/server state merely to restyle a surface.
- Details may be hidden by default without becoming second-class: contextual entry points, keyboard access, and optional pinning preserve power workflows.
- The revamp shipped dark-first; ADR 0010 later added Classic Light and Classic Dark without changing `aiqsa` as the default.
- The previous design-system recipes were migration input, not permanent constraints. Task 175 replaced the foundation before the later surface slices shipped.
- Final acceptance requires feature-inventory parity plus proportional accessibility, keyboard, responsive, and browser checks.
