# 397-custom-openai-compatible-setup

Status: done
Completed: 2026-07-26
Depends on: 396-native-gemini-transport

## Goal

Add a first-class Custom OpenAI-compatible Chat Completions setup with manual endpoint, key, model, and Test & Save.

## Scope

- Add `Custom OpenAI-compatible` as a first-class provider setup choice that reuses the reviewed generic compatible adapter boundary without pretending to be OpenAI, Gemini, or OpenRouter.
- Make the default administrator path Endpoint -> Model ID -> API key -> Test & Save, with an optional key only where the server-owned local-endpoint policy permits it. The simple task fixes the protocol to generic Chat Completions instead of asking a novice to choose a wire contract.
- Support canonical API-root validation, server-owned `/chat/completions` derivation, explicit `bearer | none` authentication, and a manual upstream model ID. `none` is available only for an explicitly allowed private/local HTTP endpoint and remains an immutable tested credential version with a real null envelope.
- Test the exact unsaved endpoint/key/model tuple outside the transaction and atomically create the active connection, credential/version, model/check, acting-admin direct credential assignment, direct entitlement, and conditional default.
- Keep headers, private-network authorization, capabilities, routing, pricing, multiple models/credentials, diagnostics, and activation lifecycle in Advanced.
- Add the task-first Control Center UI, contracts, handlers/services/repository behavior, safe endpoint policy, deterministic tests, and owning documentation/ADR amendments.

## Out Of Scope

- Automatic protocol or capability inference, arbitrary browser-supplied headers/request templates, provider-specific hosted tools, or fallback to another protocol/provider.
- A separate compatible transport implementation when the existing generic Chat adapter is correct. Existing compatible Responses configuration remains an Advanced concern rather than another field in the simple task.
- Importing an arbitrary remote catalog or creating groups for the acting administrator.
- Unrelated admin navigation or visual redesign.

## Acceptance Criteria

- An administrator can configure a compatible API from the Providers first-task surface with one bounded Test & Save operation and start using the exact manual model without visiting Groups or the multi-step Advanced lifecycle.
- Production public endpoints require HTTPS; explicit local/private endpoints follow the existing reviewed opt-in, DNS-pinning, redirect, and secret-redaction rules.
- The server owns protocol, terminal paths, authentication shape, limits, capability defaults, and validation. Unknown fields and unsafe URLs fail before outbound I/O.
- Failure or stale state performs no partial write and preserves every existing resource; success creates an actor-relative direct path and keeps entitlement separate from credential selection.
- Ordinary users cannot access the setup API and no API/browser/log/preview exposes the key or unsafe remote body.
- Bearer and explicit no-auth Chat paths have deterministic transport/runtime coverage; UI covers blank key, optional local auth where allowed, busy/error/ready, compact layout, and Advanced handoff.

## Tests

- Focused compatible Chat request/response, endpoint-policy, setup service/repository/route, current-user catalog/admission, and Providers UI suites, plus the local deterministic compatible smoke.
- Browser verification of the task-first desktop and compact setup using a deterministic compatible fixture.
- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.

## Done Notes

- Added a distinct `Connect custom endpoint` first task with the direct API root -> model ID -> API key -> Test & Save flow. One tested transaction creates the connection, immutable credential version, manual model, exact check, acting-admin credential assignment and direct entitlement, and conditional default without Groups or the Advanced lifecycle.
- Kept protocol, safe `/chat/completions` derivation, capabilities, limits, and authentication server-owned. Public roots require HTTPS; explicit private/local HTTP can use a tested `none` authentication mode with a real null secret envelope, per-request credential-version locking, DNS pinning, redirect controls, and no `Authorization` header. Legacy/invalid null-secret combinations fail closed.
- Added the route/contracts/service/repository/controller/UI, Ready receipt and exact Advanced handoff, bearer/no-auth runtime coverage, ADR 0032, and synchronized living contracts. The Advanced connection editor preserves and reports authentication mode; the simple task remains separate from the four reviewed hosted-provider choices.
- Reworked the Advanced Connections inventory after visual review so its header and provider rows form one inset bordered panel on a distinct workspace surface instead of blending into the surrounding provider screen. Desktop and 390 px visual checks showed clear hierarchy and no overflow.
- Verification passed: `docker compose -f docker-compose.dev.yml exec -T app npm run check` (304 files, 2490 tests passed; 13 intentional skips); `npm run smoke:custom-openai-compatible` for bearer/no-auth, manual model, two SSE deltas and normalized usage; and the serial provider-admin Chromium suite (5/5), including the separate Custom flow on 1440 px and 390 px, real Quick chat durability, Advanced OpenRouter, profile remapping, and ordinary-user 403 behavior.
