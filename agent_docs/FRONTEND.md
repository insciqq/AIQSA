# FRONTEND

Owner: Frontend contract router
Scope: Non-normative router to current UI behavior, state, responsive-access, and visual owners.

This file is a router, not a second copy of frontend behavior. Read only the owner needed for the change:

- [Product and functional layout](frontend/PRODUCT_AND_LAYOUT.md) — capability preservation, presentation boundary, accessibility scope, responsive shell, and overlay access.
- [Implementation and state](frontend/IMPLEMENTATION_STATE.md) — source owners, client/server state boundaries, stores, reconciliation, and testability.
- [Composer and controls](frontend/COMPOSER_AND_CONTROLS.md) — routing index for composer, workspace navigation, next-run controls, answer outputs, and Branches.
- [Account, admin, and sharing](frontend/ACCOUNT_ADMIN_AND_SHARING.md) — routing index for auth, public shares, Control Center, Settings, Assistants, and Knowledge.
- [Messages and Markdown](frontend/MESSAGES_AND_MARKDOWN.md) — message actions, branching, citations, generated artifacts, safe Markdown, code, and math.
- [Visual interaction runtime](frontend/VISUAL_INTERACTION.md) — motion-state and reduced-motion behavior.
- [Design system](DESIGN_SYSTEM.md) — routing index for palette, typography, geometry, density, composition, motion, and visual review.

Functional behavior, state ownership, and responsive access belong to the bounded frontend contracts. Visual composition belongs to the bounded owners routed by `DESIGN_SYSTEM.md`. Keep these documents current and do not reintroduce redesign chronology.
