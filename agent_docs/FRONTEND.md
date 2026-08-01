# FRONTEND

Owner: Frontend contract router
Scope: Reading map for current UI behavior, state, responsive access, and visual ownership; detailed contracts live only in the linked bounded documents.
Verified against: 4f51fdd (2026-08-01)

This file is a router, not a second copy of frontend behavior. Read only the owner needed for the change:

- [Product and functional layout](frontend/PRODUCT_AND_LAYOUT.md) — capability preservation, presentation boundary, accessibility scope, responsive shell, and overlay access.
- [Implementation and state](frontend/IMPLEMENTATION_STATE.md) — source owners, client/server state boundaries, stores, reconciliation, and testability.
- [Composer and controls](frontend/COMPOSER_AND_CONTROLS.md) — composer, workspace navigation, next-run controls, receipts, and Details.
- [Account, admin, and sharing](frontend/ACCOUNT_ADMIN_AND_SHARING.md) — auth, public shares, Control Center, Settings, and Prompt library.
- [Messages and Markdown](frontend/MESSAGES_AND_MARKDOWN.md) — message actions, branching, artifacts, safe Markdown, code, and math.
- [Visual interaction runtime](frontend/VISUAL_INTERACTION.md) — motion-state and reduced-motion behavior.
- [Design system](DESIGN_SYSTEM.md) — palette, typography, geometry, density, motion recipes, and visual review.

Functional behavior, state ownership, and responsive access belong to the bounded frontend contracts. Visual composition belongs to DESIGN_SYSTEM.md. Accepted ADRs own historical rationale; do not reintroduce redesign chronology into these living contracts.
