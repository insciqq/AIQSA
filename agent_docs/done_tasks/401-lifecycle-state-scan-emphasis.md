# 401-lifecycle-state-scan-emphasis

Status: done
Completed: 2026-07-26
Depends on: none

## Goal

Make enabled, disabled, readiness, and effective access states distinct at every resource scan point.

## Scope

- Strengthen the shared binary availability primitive so `Enabled` and `Disabled` remain visible at dense desktop and compact scan points in every supported theme.
- Apply one restrained leading-edge/resource-row treatment to provider connections, credentials, models, MCP servers, access rules, and user-account rows without making an intentional disabled state look like an error.
- Separate saved run-profile enablement from dependency readiness so an inactive provider model cannot present a false positive `Enabled` state.
- Show effective MCP access inherited from `Full access` or another group separately from the direct-user grant action.
- Audit ordinary-user Settings and composer controls and retain `Off`, `Unavailable`, readiness, and ordinary disabled-control semantics where they are not binary resource availability.
- Update the design/frontend contracts and focused component tests for the changed presentation rules.

## Out Of Scope

- Backend authorization or persistence changes.
- Changing invitation, approval, archive, publication, validation, health, selection, or form-control semantics into binary availability.
- Broader Control Center information-architecture or composer-density work.

## Acceptance Criteria

- Enabled resources use one clearly visible positive dot-and-label status; disabled resources use one clearly visible neutral dot-and-label status, with status and lifecycle action rendered separately.
- Dense resource lists expose the state through a restrained row-level scan cue as well as the text status, in light and dark themes.
- A configured run profile whose selected model/connection is inactive keeps its factual `Enabled` lifecycle and shows a separate dependency-readiness fact; disabled, enabled-ready, and enabled-unavailable profiles remain distinct.
- A user inheriting MCP use from `Full access` or an ordinary group sees that effective access source instead of a misleading standalone `Not granted`; the direct grant action remains explicit when relevant.
- User-facing Search `Off`, catalog `Unavailable`, readiness/health, grants, and ordinary disabled controls retain their separate meanings.
- Relevant focused tests, routine application checks, and desktop/mobile visual inspection pass.

## Tests

- Focused Vitest checks for the shared availability primitive, provider inventories, users, access rules, MCP catalogs/settings/grants, and run profiles.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.
- Desktop and 390px visual inspection in the running development app.

## Done Notes

- Strengthened the shared binary availability badge and added a restrained row-level scan treatment across provider connections, credentials, models, MCP servers, access rules, run profiles, and user-account inventories.
- Kept lifecycle, selection, readiness, health, grant, archive, and form-control semantics separate: run profiles now show saved enablement independently from connection/model readiness, while composer profiles expose `Available` / `Unavailable` as a separate fact.
- Added explicit four-state user presentation (`Active`, `Disabled`, `Pending`, `Denied`) and separated effective MCP access inherited through `Full access`, another group, or a direct grant from the direct-assignment action.
- Updated `DESIGN_SYSTEM.md` and `FRONTEND.md` with the lifecycle scan, multi-state user, dependency-readiness, and effective-access contracts.
- Verification:
  - focused lifecycle suite: 13 files and 122 tests passed;
  - `docker compose -f docker-compose.dev.yml exec -T app npm run check`: lint, TypeScript, docs, 306 test files and 2521 tests passed (2 files / 13 tests skipped by their integration guards);
  - desktop and 390 px visual inspection passed in light and dark themes for providers, models, run profiles, users, MCP catalog, and effective MCP access.
