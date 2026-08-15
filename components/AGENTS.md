# AGENTS

Scope: `components/**` browser rendering, interaction, and component-level state adapters.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/FRONTEND.md` for behavior, state, responsive access, and visual composition; add `agent_docs/TESTING.md` for the proportional UI lane.

- Components consume client-safe contracts and callbacks; they do not import Prisma, server repositories, secrets, route handlers, or provider transports.
- Preserve the existing state owner and responsive/focus/keyboard/touch behavior for the changed surface.
- Keep appearance choices in semantic design tokens and the owning visual spec, not duplicated component-local policy.
- Add focused Testing Library coverage for observable behavior; use Playwright only for a real browser/server or viewport boundary described in `TESTING.md`.
