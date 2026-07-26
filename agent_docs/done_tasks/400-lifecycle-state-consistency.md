# 400-lifecycle-state-consistency

Status: done
Completed: 2026-07-26
Depends on: none

## Goal

Separate resource availability from lifecycle actions and make Enabled and Disabled consistently scannable across every applicable UI surface.

## Scope

- Audit the complete frontend for user-visible resources with a real persistent enabled/disabled lifecycle and distinguish them from readiness, grants, selections, archived state, and temporarily disabled form controls.
- Move the binary availability presentation into an appropriate shared UI boundary so Control Center and ordinary-user surfaces use the same `Enabled` / `Disabled` status language.
- In `Settings -> MCP & tools`, render availability as a separate scan-point status and render `Enable`, `Disable`, or the required setup/authorization action as a distinct control.
- Correct every confirmed lifecycle-resource inconsistency found by the audit without recoloring unrelated states or inventing new backend actions.
- Update focused component/browser evidence and the owning ADR, frontend, design-system, testing, and revamp documentation where their current wording changes.

## Out Of Scope

- Backend lifecycle semantics, new enable/disable endpoints, provider/MCP capabilities, and entitlement changes.
- Publication, readiness, validation, grants, approval/invitation, archived state, selected switches, or ordinary HTML-disabled controls.
- A decorative badge pass over every occurrence of the words enabled or disabled.

## Acceptance Criteria

- Every applicable user-visible lifecycle resource exposes one explicit availability status at its scan point: positive `Enabled` or bounded high-contrast neutral `Disabled`.
- `Settings -> MCP & tools` never uses one control as both status and action; disabled resources expose a distinct proof-accented `Enable` action when directly possible, while enabled resources expose a quiet `Disable` action.
- Required setup or OAuth authorization remains the truthful action when direct enablement is not yet possible, while the separate availability status remains visible.
- Control Center lifecycle surfaces retain the same shared visual language and no unrelated readiness/grant/form-control state is reclassified.
- The affected desktop, compact, light, and dark compositions remain readable and contain their actions without page-level overflow.

## Tests

- Focused checks for the changed behavior.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.

## Done Notes

- Added the neutral shared `components/resource-lifecycle/AvailabilityStatus.tsx` boundary so app-shell and Control Center render the same positive `Enabled`, strongly neutral `Disabled`, proof-accented restoration action, and quiet removal action without crossing feature boundaries.
- Audited the full frontend and kept publication, readiness, grants, selections, archive state, invitations, approvals, and ordinary disabled controls out of the lifecycle treatment. Group grants now say `Granted` / `Not granted`, disabled group members use the existing user-status treatment, and disabled access rules describe their actual non-applying behavior.
- Separated ordinary-user MCP availability from `Enable` / `Disable` / setup / OAuth actions, ordered personal setup before OAuth when both are required, blocked repeated OAuth submission, kept operational readiness visible as a separate axis, and exposed the aggregate status plus partial-readiness fact in the composer.
- Corrected provider Quick Setup, connection, credential, and model scan points; removed the duplicate connection Enable action; surfaced credential restoration directly; and retained explicit saved-versus-unsaved lifecycle truth for run-profile edits.
- Corrected SMTP Runtime so an absent active snapshot is `Not configured`, removed the redundant detail-footer runtime chip, and kept real active Enabled/Disabled separate from its action.
- Updated ADR 0033, the ADR index, `FRONTEND.md`, `DESIGN_SYSTEM.md`, `TESTING.md`, and `REVAMP.md` to describe the implemented product-wide contract.
- Verification:
  - `docker compose -f docker-compose.dev.yml exec -T app npm run check` — passed: 305 files / 2514 tests, with 2 files / 13 tests intentionally skipped.
  - `docker compose -f docker-compose.dev.yml exec -T -e PLAYWRIGHT_REUSE_SERVER=1 app npx playwright test tests/e2e/mcp-ui.spec.ts tests/e2e/provider-admin-ui.spec.ts tests/e2e/admin-email-ui.spec.ts tests/e2e/auth-admin.spec.ts --project=chromium` — 18 passed.
  - Visual inspection covered light and dark palettes at 1440px and the 390px compact MCP composition; no horizontal overflow was observed.
  - `git diff --check` — passed.
