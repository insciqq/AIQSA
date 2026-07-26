# 392-revamp-team-and-advanced-admin

Status: done
Completed: 2026-07-26
Depends on: 391-personal-provider-quick-setup

## Goal

Replace Team and Advanced Control Center workflows across every remaining real admin destination.

## Scope

- Replace Users, Groups, Model access, Invites, Access rules, Email delivery, Providers Advanced, and MCP servers with task-led list/detail workflows.
- Preserve every current lifecycle, guard, secret, validation, activation, routing, credential-assignment, and access capability.
- Retire each legacy renderer immediately after its parity evidence closes.

## Out Of Scope

- New audit/revision product concepts, provider rollback, or entitlement shortcuts.
- WCAG conformance, dedicated accessibility implementation/audits, and accessibility acceptance gates. Responsive/mobile/touch behavior remains ordinary UX scope.

## Acceptance Criteria

- Every real admin capability and state remains reachable on desktop, tablet, and phone.
- Credential assignment is consistently presented as authentication policy, not entitlement.
- Advanced provider and MCP workflows preserve exact testing/activation/recovery consequences without polluting Personal setup.
- No untracked legacy admin body remains mounted.

## Tests

- Focused section/controller/API/provider/MCP/email suites.
- Team model-access and Advanced provider/MCP/email browser journeys.
- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.

## Done Notes

- Replaced Users, Groups, Model access, Invites, and Access rules with shared task-led index/detail composition while preserving filters, drafts, lifecycle guards, effective-access inspection, MCP grants, confirmations, and compact Back context.
- Rebuilt Advanced Providers as peer Connections and Run profiles workspaces. Connection detail now owns focused Credentials, Authentication policy, Models, and Diagnostics tasks; authentication assignment remains distinct from entitlement and destructive actions use the app confirmation host.
- Rebuilt MCP servers as catalog/detail plus Overview, Definition, Validate & tools, Revisions, Runtime, and deletion tasks; rebuilt Email delivery as Overview, Draft configuration, Test & activate, Runtime & health, and Clear configuration tasks. Existing version, OAuth, write-only-secret, activation, rollback/rebuild, health, and recovery contracts remain intact.
- Advanced is lazy and fully unmounts when returning to Personal Quick setup, so its editor state and unsaved secrets cannot remain in a hidden second owner. Quick refetches before another Advanced mount.
- Added replacement-responsive browser coverage at 1440x900, 768x1024, 390x844, and 844x390, including compact index/detail Back, query preservation, overflow, real non-admin denial, and destructive paths.
- Verification passed:
  - `docker compose -f docker-compose.dev.yml exec -T app npm run check` (290 files / 2328 tests passed; 2 files / 10 opt-in tests skipped).
  - `components/admin/AdminPanel.test.tsx` (38/38) and all focused replacement component/controller suites through the routine check.
  - `tests/e2e/auth-admin.spec.ts` Chromium (8/8).
  - `tests/e2e/provider-admin-ui.spec.ts` Chromium (4/4 after the final unmount fix).
  - `tests/e2e/admin-email-ui.spec.ts` plus `tests/e2e/admin-mcp-ui.spec.ts` Chromium (3/3).
  - Scoped ESLint, TypeScript, docs check, and `git diff --check` passed.
- WCAG/accessibility implementation and acceptance gates remained excluded by operator decision; responsive/mobile/touch verification remained in scope.
