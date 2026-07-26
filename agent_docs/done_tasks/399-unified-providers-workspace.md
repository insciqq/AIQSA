# 399-unified-providers-workspace

Status: done
Completed: 2026-07-26
Depends on: none

## Goal

Implement the approved unified Providers workspace and a clear, reusable lifecycle-state language across Control Center resources.

## Scope

- Replace the separate Quick/Advanced Providers pages with one persistent task row: `Setup`, `Connections`, and `Run profiles`.
- Keep provider API-key setup as the default, shortest path and keep custom endpoint setup inside `Setup`.
- Make contextual setup handoffs open the exact matching connection while generic task switching preserves the current Connections workspace.
- Preserve lazy loading and clear write-only setup secrets whenever the operator leaves the active setup flow.
- Introduce semantic `Enabled` and `Disabled` presentation plus distinct enable/disable actions for actual lifecycle resources.
- Apply the shared lifecycle treatment to provider connections, provider models, provider credentials, users, MCP servers, and other existing Control Center surfaces that expose the same runtime state.
- Update focused component/browser coverage and the owning frontend, design-system, and ADR contracts.

## Out Of Scope

- Provider/backend lifecycle changes, new provider capabilities, and permission-model changes.
- Reworking grant toggles, form-disabled controls, publication/readiness states, or every incidental use of the word “disabled”.
- Accessibility implementation remains deferred under the current product contract; ordinary responsive and overflow verification remains required.

## Acceptance Criteria

- Providers opens on `Setup` with `Connections` and `Run profiles` continuously visible as peer tasks; there is no separate Advanced page, Advanced header, or Back-to-quick navigation.
- The code-owned setup path remains provider -> key -> `Test & Save`, with a prominent contextual action to manage the selected provider connection.
- Connections retains its full create/edit/credentials/authentication/models/diagnostics lifecycle and contextual handoffs resolve the canonical or exact connection.
- Switching provider tasks does not eagerly load hidden provider/run-profile resources and does not retain a write-only secret outside its setup flow.
- Enabled resources use a clearly positive status, disabled resources use a distinct semantic accent, and enable actions visibly communicate restoration while disable actions remain legible and secondary.
- The lifecycle-state treatment is consistent across all actual Control Center resources in scope and does not color unrelated disabled HTML controls or grant toggles.
- Compact and desktop Providers layouts remain usable without horizontal page overflow.

## Tests

- Focused component tests for Providers task switching, lazy resource ownership, secret clearing, contextual connection handoff, and lifecycle-state primitives/call sites.
- Focused Playwright provider-admin coverage at desktop and compact widths.
- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.

## Done Notes

- Replaced the split quick/advanced Providers experience with one persistent `Setup` / `Connections` / `Run profiles` workspace. Setup keeps provider -> API key -> `Test & Save` as the shortest path, while contextual management opens the matching connection and hidden workspaces remain lazily owned.
- Added shared lifecycle-state primitives and applied the resulting visual language across provider connections, models, credentials, users, MCP servers, email runtime state, run profiles, and access rules: positive `Enabled`, bounded high-contrast neutral `Disabled`, accented `Enable`, and secondary `Disable`.
- Updated ADR 0033 plus the owning frontend, design-system, testing, and amended provider-setup contracts.
- Verification passed: `npm run docs:check`, `npm run lint`, `npm run typecheck`, focused component suites (109 tests), focused Chromium provider-admin Playwright coverage (5 tests), `docker compose -f docker-compose.dev.yml exec -T app npm run check` (304 files passed, 2 skipped; 2502 tests passed, 13 skipped), and `git diff --check`.
