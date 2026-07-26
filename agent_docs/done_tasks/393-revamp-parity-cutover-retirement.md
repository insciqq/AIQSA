# 393-revamp-parity-cutover-retirement

Status: done
Completed: 2026-07-26
Depends on: 392-revamp-team-and-advanced-admin

## Goal

Close task-based parity and UX evidence, retire the complete legacy view layer, finalize living docs, and publish main to origin.

## Scope

- Execute the seven required task-based UX walkthroughs with desktop/mobile evidence and key milestone screenshots only.
- Close every capability/state parity row, performance budget, route alias, and browser-persistence migration; WCAG/accessibility gates are excluded.
- Remove legacy view components, adapters, styles/tokens, shape tests, temporary parity ledger, and stale living-doc references.
- Record permanent completion evidence, finish the epic, make coherent final commits, and push `main` only to `origin`.

## Out Of Scope

- GitHub publication or retaining a classic/new runtime switch.

## Acceptance Criteria

- Workspace, admin, auth, and share default routes contain only the replacement presentation tree.
- LCP/INP/CLS targets and large-thread/catalog/list responsiveness are measured where tooling permits and regressions are documented/fixed.
- No WCAG or dedicated accessibility claim is made; that work remains explicitly deferred.
- Living docs describe only shipped runtime; the parity ledger is removed and its evidence is in the permanent done journal.
- `git status` contains only intended changes and `main` is pushed only to `origin` after all checks pass.

## Tests

- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.
- Relevant full Playwright journeys at 1440x900, 768x1024, 390x844, and 844x390.
- Final overflow, theme, performance, and secret scans.

## Done Notes

- Cut over Research Chat, Control Center, auth, and public share at their existing routes with one replacement presentation tree. Removed compatibility color aliases, legacy renderer markers, temporary old-shape tests, duplicated TopRail actions, and stale migration wording; no `/v2`, classic/new switch, duplicate store, or hidden fallback remains.
- Audited and satisfied all 96 temporary ledger rows (`RC` 35, `AUTH` 3, `SHARE` 3, `CC` 25, cross-cutting 14, journeys 7, retirement gates 9), transferred their aggregate evidence here, and deleted the temporary parity ledger.
- Completed the seven release journeys through composite deterministic evidence:
  - auth into ready/empty/recovery workspaces, registration and isolated ordinary-user sessions;
  - blank/root/folder research creation, organization, search, switching, concurrent/background runs, and source-local recovery;
  - exact model/profile/run setup, mixed uploads, send failure recovery, streaming, cancellation, reload, and first-answer persistence;
  - Markdown/evidence/citation/reasoning/tool inspection, edit/branch/copy/share/revoke and sanitized public rendering;
  - prompts, all six themes, Settings, command palette, project instructions, and personal MCP/OAuth flows;
  - Personal provider Quick setup from one write-only key through picker/retry/Ready and the first persisted-provider answer against the deterministic local Responses fixture, including safe failed replacement;
  - all ten real Control Center destinations, Team grants, Advanced provider/profile, email, MCP revision, Usage, denial, and safety flows.
- Rechecked the shipped screens against retained concept references `01`, `06`, `07-v4`, and `08`. The resulting hierarchy keeps the concept's quiet research-document flow, contextual evidence, Personal/Team/Advanced separation, and compact task views while using only real destinations and capabilities. All 33 tracked concept files remain unchanged, including 16 PNGs.
- Added `paper` as the sixth stable theme beside `aiqsa`, `graphite`, `verdant`, `classic-dark`, and `neutral`. It uses the approved near-monochrome light paper/graphite direction, persists across reload, preserves the existing default and stored theme IDs, and was inspected on chat, auth, share, and Control Center at desktop and compact sizes.
- Simplified final hierarchy details after code-rendered comparison: conversation actions are consolidated in one menu; unavailable model grants are one counted disclosure; repeated Users/Model access and Advanced Providers explanations/actions are removed; Quick and Advanced provider workspaces still fully unmount across the mode boundary.
- Responsive and large-fixture evidence covered 1440x900, 768x1024, 390x844, 384x844 where applicable, and 844x390; a 36-message plus 80-paragraph streamed thread; 333-provider-model administration; a 350-model picker; 27 users; and 30 long command items. No page-level overflow or control loss was observed. These fixtures prove the documented bounded product views, not an unlimited-data virtualization claim.
- One warm-localhost Chromium 148 lab run at 1440x900 with `paper`, a fresh context, and no throttling measured chat LCP 456 ms / CLS 0.0059174501 and Admin Users LCP 200 ms / CLS 0.0002963177. Representative Event Timing maxima were 32 ms for Settings, 16 ms for the model picker, and 24 ms for the admin user filter. This is one local lab sample, not field data or a 75th-percentile INP claim.
- Verification:
  - `docker compose -f docker-compose.dev.yml run --rm -T app npm run check`: 290 Vitest files / 2331 tests passed; 2 files / 10 opt-in integration tests skipped; docs, lint, and typecheck passed.
  - `docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e`: 62/62 Chromium scenarios passed against a reset disposable development database.
  - Focused recovery evidence passed for rejected-send retry, partial upload success, preserved citation disclosure, standalone/reusable Quick setup, all six themes, TopRail, Team access, Advanced Providers, and MCP form settlement.
  - Static scans found no compatibility token names, legacy renderer markers, native browser dialogs, stale living-doc cutover references, or `/v2` presentation route. Diff/tracked-tree scans found no pasted project-key prefix; `.env` remains ignored.
- WCAG conformance, screen-reader/forced-colors work, keyboard-only certification, formal contrast/focus audits, and any accessibility claim were explicitly excluded by the operator and were not implemented or claimed. Responsive, touch, safe-area, software-keyboard, overflow, and readability behavior remain verified product requirements.
