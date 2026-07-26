# 391-personal-provider-quick-setup

Status: done
Completed: 2026-07-26
Depends on: 390-revamp-control-center-shell

## Goal

Implement the server-owned atomic OpenAI, Anthropic, and OpenRouter Personal provider Quick setup and its UI.

## Scope

- Add one active-admin-only Quick setup endpoint, contracts, orchestrator, repository transaction, and fake transports for canonical OpenAI, Anthropic, and OpenRouter templates.
- Validate the write-only unsaved key and bounded catalog outside the transaction, select a deterministic code-owned recommendation or request one compact model choice, then fenced-commit the complete usable graph.
- Build Provider -> API key -> Test & Save -> Ready presentation and non-destructive replacement flow.

## Out Of Scope

- Paid diagnostics, custom compatible endpoints, group mutations, or a browser-composed mutation chain.
- WCAG conformance, dedicated accessibility implementation/audits, and accessibility acceptance gates. Responsive/mobile/touch behavior remains ordinary UX scope.

## Acceptance Criteria

- Initial success atomically produces the canonical connection, Primary/default credential, use_default policy, active deployment/check, acting-admin direct model grant, a conditional user default, and at most one exact provably untouched profile fill. Bounded recovery preserves an existing supported model, fills no profile, and never adopts ambiguous Team/Advanced state.
- Success is returned only when the selected deployment appears in the acting admin's filtered catalog; failures preserve prior active state and retain retryable input only in the browser.
- Existing usable defaults/profiles are not overwritten, groups are untouched, and no secret reaches response/log/evidence/UI.
- OpenAI, Anthropic, and OpenRouter pass deterministic fake-transport success, picker, conflict, stale, recovery, replacement, and rollback cases.

## Tests

- Focused contract/service/repository/route/UI tests with fake transports.
- Personal fresh-admin browser journey without a paid provider call.
- Provider control-plane focused suite and routine Compose check.

## Done Notes

- Added the active-admin-only Quick setup contract, endpoint, deterministic policy-v1 catalog tester, domain-separated state fences, strict canonical eligibility projection, and one fenced `SERIALIZABLE` repository commit for initial, bounded recovery, and safe credential replacement.
- The Personal Providers view now defaults to Provider -> API key -> Test & Save -> Ready, keeps the full provider control plane and Run profiles lazy behind Advanced, gives a factual success receipt, preserves retryable browser input, and refetches Quick only when returning from Advanced.
- Repository evidence covers every initial/replacement write-boundary rollback, late recovery and catalog rollback, byte-identical prior credential versions, exact Team graph preservation, Quick-versus-Advanced and real concurrent Quick commits, bounded PostgreSQL `40001` retry, and transaction-local current-user catalog visibility. The browser journey mocks only Quick, then proves the selected Sol model through the real catalog, chat/message pipeline, local Responses SSE transport, saved answer, complete run, and exact provider binding without a paid request.
- Verification: focused Quick Vitest `116/116`; opt-in Prisma integration `7/7`; provider Playwright `4/4`; routine Compose `npm run check` `2303 passed, 10 skipped`; post-audit lifecycle delta Vitest `22/22`; docs check and diff check passed.
