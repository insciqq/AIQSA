# 395-composer-provider-followup

Status: done
Completed: 2026-07-26
Depends on: none

## Goal

Correct the screenshot follow-ups, restore direct run selection, and add current first-party model setup with Gemini

## Scope

- Align the Users directory grid so headers and every row share one stable column geometry without wasting the desktop work area.
- Expose concrete Model, Profile, and Search selectors directly from the composer in one click while retaining one draft/state owner and the complete advanced Run setup.
- Remove the visually orphaned chevron beside Tools.
- Merge search-call, citation, and terminal run metadata into one compact answer evidence block.
- Make Quick setup install every code-owned current model visible in the provider account catalog, while keeping one recommended model for default/profile decisions.
- Add OpenAI GPT-5.6 Sol/Terra/Luna and Anthropic Claude Opus 5/Sonnet 5 as the current first-party Quick setup set.
- Add a first-class Gemini family backed by Google's official OpenAI-compatible chat endpoint, including Quick setup, runtime, credential discovery, current Gemini defaults, and low-token real-key smoke coverage.
- Re-audit and strengthen the built-in `Full access` contract so the group is created by default, cannot be renamed/archived/deleted, contains the first administrator, and continuously entitles explicit members to every current and future provider, model, search strategy, and MCP server without manual grant maintenance.
- Record the external model/API evidence and resulting frontend/backend contracts.

## Out Of Scope

- Blind import of arbitrary provider IDs whose chat/runtime capabilities cannot be established from the provider catalog.
- Gemini media generation, Live API, native Google Search grounding, or Interactions API state management.
- Pricing as billing truth or unrelated provider/control-plane redesign.
- Dedicated accessibility implementation or WCAG conformance.

## Acceptance Criteria

- Users table headers and row values align at the captured desktop width and remain contained on compact layouts.
- Model, Profile, and Search each open their existing selector with one composer action; all other run controls remain reachable and Tools has no unrelated leading chevron.
- Search calls, citations, and run completion facts occupy one coherent compact block with the same disclosures and content still reachable.
- OpenAI Quick setup makes GPT-5.6 Sol, Terra, and Luna available when returned by the tested account catalog; Anthropic does the same for Claude Opus 5 and Sonnet 5.
- Quick setup provisions all matching current code-owned candidates atomically, grants the acting administrator each model, records exact checks, and leaves unrelated custom/team state untouched.
- Gemini appears as an ordinary Quick setup provider, validates a Gemini key through the account model catalog, activates supported current Gemini chat models, and can execute a minimal real run through the normal runtime adapter.
- Remote discovery normalizes provider-specific catalog identifiers but never treats arbitrary image/audio/embedding IDs as runnable chat deployments.
- `Full access` remains a lifecycle-immutable system identity, first-administrator membership is repaired idempotently, and both existing and newly created provider/model/search/MCP resources become entitled without per-resource administrator clicks; provider credential selection and personal MCP secrets remain separate readiness boundaries.
- Living docs and ADRs describe the new one-click composer disclosure and Gemini/provider-catalog decision.

## Tests

- Focused checks for the changed behavior.
- Disposable migration, bootstrap, entitlement, run-admission, MCP future-insert, lifecycle-guard, and presentation checks for `Full access`.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.

## Done Notes

- Delivered aligned/clickable Users rows, direct composer Model/Profile/Search controls plus one complete More setup, removal of the orphaned Tools chevron, and one compact Run/Search/Citations answer receipt with the existing detailed disclosures preserved.
- Quick setup now presents OpenAI, Anthropic, Gemini, and OpenRouter directly; it intersects the account catalog with the reviewed policy-v2 model set, atomically installs every matching candidate, records exact checks and acting-admin grants, and keeps one selected candidate as the default/profile choice. Gemini uses the official compatible-chat root, family-specific params/tool bridging, streamed thought-signature replay, and a bounded real-key tool-loop smoke.
- Re-verified and strengthened the built-in `Full access` contract: immutable system identity, first-admin owner membership, semantic current/future provider/model/search entitlement, materialized current/future MCP coverage, and explicit credential/personal-secret readiness boundaries. Quick Prisma integration now runs in temporary schemas so saved development credentials, custom connections, and provider-run bindings cannot contaminate rollback cases.
- Recorded the durable decision in ADR 0030 and synchronized the owning frontend, design-system, provider, runtime, security, environment, testing, README, configuration, and revamp contracts.
- Verification passed: `npm run check` in `docker-compose.dev.yml` (292 files, 2392 tests); opt-in Quick Prisma integration (10/10); focused `Full access` suite (136/136) and disposable migration contract; focused composer, Quick setup, and real-data `Full access` Playwright paths (1/1 each); desktop/mobile visual containment checks; and `npm run smoke:gemini` with one tool execution, response/signature presence, signature round trip, and final-output/argument matches all true without secret or content output.
