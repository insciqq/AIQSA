# 396-native-gemini-transport

Status: done
Completed: 2026-07-26
Depends on: none

## Goal

Replace Gemini compatibility code with a native Interactions API transport, streaming, Google Search, migrations, and no fallback.

## Scope

- Replace every first-class Gemini runtime, catalog-test, preview, and tool-continuation use of `openai_chat_completions_compatible` with one code-owned native Gemini Interactions v1 adapter.
- Use stateless `store=false` requests, AIQSA-owned history, native SSE streaming, custom-function continuation, thought/signature preservation, normalized usage/errors/artifacts, and the existing provider-neutral tool loop.
- Add an explicit `gemini-google-search` strategy for eligible native Gemini deployments. Parse native search steps internally without adding a generic execution-steps UI.
- Keep Google Search Suggestions, citation Links, and the grounded answer transient and bounded for the live result display; never persist or log their provider markup, Links, or answer text. Atomically replace any pre-marker draft/event content with explicit provenance plus a neutral history placeholder.
- Never reuse grounded answer text as later provider context and block anonymous/public sharing of any branch that contains grounded live-only provenance. A selected hosted-search tool that is not actually called may still produce an ordinary durable answer; once a native search call begins, the run is irreversibly live-only.
- Migrate canonical Gemini connection/model adapter configuration in one clean cutover, preserve stored credentials and completed historical run snapshots, and fail old non-terminal compatible Gemini work closed without a runtime fallback.
- Remove Gemini-specific compatibility request/response/bridge/smoke code while retaining the generic compatible adapters for non-Gemini endpoints.
- Record the durable decision in a new ADR that amends ADR 0030 and update every owning living contract, smoke script, and provider date/source note.

## Out Of Scope

- Provider-side conversation ownership or stored Interactions.
- A generic execution-step timeline/UI, Live API, media generation, and unsupported native features.
- Any Gemini compatibility fallback, feature flag, dual transport, or automatic retry through Chat Completions.
- Unrelated provider or Control Center redesign.

## Acceptance Criteria

- New Gemini admissions and recovered native work resolve only `gemini_interactions_native`; no first-class Gemini path constructs the generic compatible adapter.
- Streaming requires native terminal proof and preserves partial text/usage on a later safe failure according to the common run contract.
- Native function tools round-trip over the existing bounded tool loop, including the provider continuation/signature data required by Gemini.
- Search Off omits the hosted tool; `gemini-google-search` exposes truthful live activity plus transient safe citations and Search Suggestions without persisting provider Link metadata, answer text, or raw markup.
- A grounded result is displayed live only after its exact Search Suggestions pass the strict server allowlist; no answer token is emitted before that proof. Reloaded private history contains only provenance plus a neutral placeholder, cannot be shared publicly, and never resubmits the grounded answer as provider context.
- Canonical Quick/Advanced model catalog tests use native Gemini authentication/endpoints and the reviewed bounded model set.
- A committed migration converts canonical Gemini configuration without changing keys, grants, defaults, or completed run evidence and settles incompatible active rows safely.
- Deterministic request/response/stream/truncation/tool/search/migration/runtime tests pass, followed by the sanitized low-token real-key smoke when the local key exists.

## Tests

- Focused native Gemini adapter, runtime factory, Quick setup, catalog/search, provider-tool-loop, persistence, migration-contract, and UI evidence suites.
- `npm run smoke:gemini` with sanitized boolean/count output when `GEMINI_API_KEY` is present.
- `docker compose -f docker-compose.dev.yml exec -T app npm run check`.

## Done Notes

- Replaced the first-class Gemini compatibility path with the code-owned `gemini_interactions_native` adapter on the stable Interactions v1 endpoint. Requests are stateless (`store=false`), stream native SSE, preserve private continuation signatures across the bounded provider-neutral tool loop, normalize usage/errors, and have no Chat Completions fallback.
- Added the explicit `gemini-google-search` strategy and live-only grounding boundary: exact Google Search Suggestions are server- and browser-validated for isolated live display, while grounded answer text, provider markup, citation Links, and signatures are excluded from persistence, logs, replay, later context, and public shares. Runs where Search is selected but never called remain ordinary durable answers.
- Added the atomic cutover migration, runtime/catalog fail-closed checks, historical active-run settlement, native migration contract, replacement smoke, ADR 0031, and synchronized provider, pipeline, frontend, backend, security, environment, architecture, testing, configuration, README, and revamp contracts. Generic compatible adapters remain available only to non-Gemini families.
- Verification passed: `docker compose -f docker-compose.dev.yml exec -T app npm run check` (304 files, 2490 tests passed; 13 intentional skips); `npm run db:gemini:migration:contract`; development migration deploy, `npm run db:integrity:smoke`, and `npm run db:seed:smoke`; focused native request/response/stream/tool/search/runtime/persistence suites; and the sanitized real-key `npm run smoke:gemini` with native streaming, two provider rounds, one tool execution, signature round trip, and matched final output.
