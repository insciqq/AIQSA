# 384-clean-slate-ui-revamp-epic

Status: done
Completed: 2026-07-26
Depends on: 393-revamp-parity-cutover-retirement

## Goal

Deliver the approved AIQSA Research Chat and Control Center clean-slate revamp through full capability parity, legacy retirement, verification, and origin publication.

## Scope

- Coordinate tasks 385-393 as one in-place presentation migration.
- Preserve the approved design brief, grounded mockups, behavioral owners, routes, privacy, and entitlements.
- Close only after the replacement is default everywhere, Quick setup works, legacy presentation is gone, and final evidence is permanent.

## Out Of Scope

- New product destinations, commercial plans, provider protocols, or a second frontend runtime.

## Acceptance Criteria

- Every child task is complete and the temporary parity ledger has no open row.
- Research Chat, Control Center, auth, and public share use only the replacement visual system.
- Personal, Team, and Advanced workflows are verified and the old view tree is removed.
- Final checks pass and `main` is pushed only to `origin`.

## Tests

- Evidence from tasks 385-393.
- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.
- Relevant repository Playwright journeys at the required viewports.

## Done Notes

- Completed child tasks 385 through 393 and replaced the presentation in place at `/`, `/login`, `/admin`, and `/s/[shareToken]`; existing backend routes, contracts, stores, privacy boundaries, entitlements, and browser-persistence identities remain authoritative.
- Shipped the clean-slate Research Chat document flow, responsive Workspace/composer/Run receipt/Details hierarchy, rebuilt auth and anonymous share surfaces, and the grouped Personal/Team/Advanced Control Center with all ten real destinations.
- Personal provider setup is now the direct provider → write-only key → Test & Save → optional server-returned model choice → Ready → Start chatting path. It requires no self-group or manual model grant, while Team grants and Advanced provider/profile validation remain available in their own explicit workflows.
- Added the retained-concept-aligned light `paper` theme beside all five previous stable themes, without changing first-use `neutral` or stored valid theme choices. Retained concept art remains unchanged and tracked.
- Audited and satisfied all 96 capability, journey, cross-cutting, and retirement rows; removed compatibility tokens, renderer markers, legacy-only shape assertions, duplicated presentation ownership, the temporary parity ledger, and stale living-doc migration narrative.
- Final evidence includes 290 Vitest files / 2331 passing tests, docs/lint/typecheck success, 62/62 standalone Chromium E2E scenarios, focused provider/recovery checks, required desktop/tablet/portrait/landscape inspection, large fixtures, clean legacy/secret scans, and bounded localhost LCP/CLS/Event Timing measurements recorded in task 393.
- The publication boundary is unchanged: development `main` goes only to private GitLab `origin`; no GitHub visibility, release ref, or mirror operation is part of this epic. The final integrating commit is prepared for that origin-only push.
- WCAG/accessibility implementation and conformance claims were explicitly excluded by the operator and are not part of this completion. Responsive/mobile/touch/overflow/readability requirements were retained and verified.
