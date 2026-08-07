# FRONTEND ACCOUNT — BOUNDARIES AND CHANGE RULES

Owner: Account and Control Center UI maintainers
Scope: Cross-cutting visual/server ownership boundary and change rules for account, sharing, administration, Settings, and Assistants.
Read when: Changing ownership between frontend behavior, visual recipes, server authorization, secrets, transactional outcomes, or maintaining these account/admin contracts.
Code owners: Account, public-share, Control Center, Settings, and Assistant frontend owners.
Not owned here: Feature-specific interaction details, visual token definitions, or server-side authorization behavior.

Visual tokens, geometry, and reusable recipes are routed by [the design system](../../DESIGN_SYSTEM.md). Server authorization, secret handling, and transactional outcomes are routed by [security](../../SECURITY.md) and [the backend API](../../backend/API_AND_AUTH.md).

## Change Rules

- Preserve authorization and least-data boundaries; client affordances never replace server enforcement.
- Keep resource facts, readiness, publication, entitlement, and action state distinct.
- Keep compact navigation and focus recovery operable at 390x844 and 844x390 without page-level horizontal overflow.
- Update this document for durable account, admin, share, Settings, or Assistants behavior. File wiring and implementation chronology belong in source and focused tests.
