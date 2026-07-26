# ADR 0031: Native Gemini Interactions And Live-Only Grounding

Status: Accepted
Amends: 0004-private-auth-entitlements-uploads-and-sharing, 0006-custom-safe-markdown-renderer, 0022-admin-managed-llm-provider-control-plane, 0030-direct-run-controls-and-reviewed-provider-catalog

## Context

ADR 0030 introduced Gemini through Google's OpenAI-compatible Chat Completions surface. That made the first setup path available quickly, but it left first-class Gemini behavior constrained by a compatibility protocol and required Gemini-specific extension handling inside a generic adapter. Native Google Search, native Interactions streaming, and the native function/thought continuation contract do not belong in that compatibility seam.

Google's native Search contract also has a display and retention boundary that is stricter than ordinary answer persistence. Search Suggestions must be displayed with the associated grounded result and citation Links are part of that transient presentation. Treating provider markup as ordinary Markdown, persisting it in run artifacts, or silently replaying a grounded answer into later model context would violate AIQSA's local-content and transparent-provider boundaries.

## Decision

### One native Gemini protocol

First-class `gemini` deployments use only the closed `gemini_interactions_native` adapter kind and Google's stable `https://generativelanguage.googleapis.com/v1/interactions` endpoint. Requests authenticate with `x-goog-api-key`, set `store: false`, carry AIQSA-owned branch history, and use the native Interactions request, response, SSE, tool, usage, and error schemas.

The family/adapter pairing fails closed in both directions: a Gemini deployment cannot select a generic compatible adapter and the native adapter cannot be attached to another family. There is no compatibility fallback, feature flag, dual write, or retry through Chat Completions. Generic compatible Responses/Chat adapters remain available for Custom/OpenRouter-like endpoints where their explicit protocol is correct.

Native streaming requires the Interactions created/step/terminal sequence and the final `done` proof. EOF, an unsupported event or step, malformed cumulative usage, a failed/cancelled/incomplete terminal state, unfinished steps, trailing data, or text disagreement between streamed and terminal state fails safely. Usage maps Google's cached input and thought fields into AIQSA's normalized counters; reasoning tokens remain a subset of output tokens.

`store: false` means AIQSA never relies on provider conversation ownership or `previous_interaction_id`. Native custom functions still reuse the provider-neutral bounded tool loop. The exact thought signatures and function transcript required for a normal continuation are retained only in the private recoverable checkpoint and next wire request; previews, logs, public events, and UI projections redact them. Search and client/MCP functions are mutually exclusive in one Gemini run for this cutover.

### Native Google Search is live-only after an actual search call

The explicit entitled `gemini-google-search` strategy adds the native `{ type: "google_search" }` hosted tool. Search Off omits it. Selecting the strategy does not claim that the model called Search: if the interaction completes without a native search call, its answer follows the ordinary persistence contract.

Once a native search call/result is observed, the run irreversibly enters grounded live-only mode before any grounded answer token can be emitted or persisted. The adapter buffers model text until non-empty Search Suggestions have passed a strict bounded server parser/allowlist. A search call without valid Suggestions fails closed and releases no buffered answer. The live event contains only bounded call/query counts, sanitized transient citation Links, and the exact validated Suggestions markup.

Suggestions render only in an isolated ShadowRoot through a second browser-side allowlist. They do not pass through the Markdown renderer, cannot execute scripts or load arbitrary CSS/URLs, and may link only to reviewed Google HTTPS destinations. Search Suggestions, citation Links, search signatures/results, and grounded answer text are never stored in `Message`, `ModelRunEvent`, request/response previews, error payloads, logs, or share snapshots.

The first grounding marker atomically fences persistence: any token/artifact draft written before the marker is removed, later durable token/artifact appends are disabled, and completion/failure stores only normalized usage/terminal evidence, explicit Gemini/search provenance, and a neutral history placeholder. The actual answer, citations, and Suggestions remain available in the current live stream and final in-memory chat update only. Reloaded history cannot reconstruct them; later provider context substitutes the neutral placeholder rather than the grounded text. A visible branch containing grounded provenance cannot be published as an anonymous share.

### Stopped migration

One atomic migration changes canonical Gemini connection roots and deployment adapters without incrementing logical draft/active versions, enables the reviewed native-search capability, adds the strategy and message provenance columns, and preserves credentials, encrypted envelopes, assignments, entitlements, defaults, checks, and every execution snapshot. Completed historical compatible runs remain immutable. Old non-terminal compatible Gemini runs are settled with a retry-required error and pending/running tool calls are cancelled because their removed wire transcript cannot be resumed safely. Unknown Gemini roots/configuration abort the entire migration.

## Consequences

- Gemini features now follow Google's native contract without contaminating generic compatible code or retaining a fallback.
- Google Search results are useful during the live run but deliberately do not become durable chat memory; the placeholder makes that limitation explicit after reload.
- Search-plus-MCP in one Gemini request and generic execution-step UI remain deferred.
- Provider schema changes require native request/SSE/grounding tests, the disposable migration contract, and a sanitized bounded real-key smoke.
