# GEMINI NATIVE INTERACTIONS API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official constraints and verified caveats for the native Gemini Interactions API.
Read when: Changing Gemini models, native transport, streaming, signatures, tools, grounding, Search, or attachment mapping.
Code owners: `lib/server/providers/geminiInteractions*.ts` and Gemini provider setup.
Not owned here: AIQSA runtime mapping details, grounding retention policy, normalized run semantics, or compatible Gemini routes.

## Gemini Native Interactions API

Last verified: 2026-08-12.

Primary references:

- `https://ai.google.dev/gemini-api/docs/models`
- `https://ai.google.dev/gemini-api/docs/latest-model`
- `https://ai.google.dev/gemini-api/docs/interactions-overview`
- `https://ai.google.dev/api/interactions-api-v1`
- `https://ai.google.dev/gemini-api/docs/api-versions`
- `https://ai.google.dev/gemini-api/docs/streaming`
- `https://ai.google.dev/gemini-api/docs/function-calling`
- `https://ai.google.dev/gemini-api/docs/google-search`
- `https://ai.google.dev/gemini-api/docs/tool-combination`
- `https://ai.google.dev/gemini-api/terms`

Externally constrained facts:

- Stable native v1 Interactions uses `POST https://generativelanguage.googleapis.com/v1/interactions`; the Gemini API key is sent through `x-goog-api-key`, and `store: false` accepts caller-supplied complete history.
- After a valid bounded control passed, stable v1 returned HTTP 400 for a three-step `store: false` interaction whose first `user_input` contained exactly one `{ type: "text", text: "" }` part.
- Models catalog entries use identifiers such as `models/gemini-...`.
- The reviewed explicit model ids are `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-pro-preview`. Their reviewed catalog controls use a 1,000,000-token context window and at most 65,536 output tokens, with model-specific `minimal`/`low`/`medium`/`high` reasoning-effort choices. Explicit ids are preferred to hot-swapping latest aliases.
- Interactions expresses generation controls under `generation_config`, accepts native typed input/step arrays, returns step types such as model output, thought and function calls/results, and exposes cumulative token fields including cached and thought totals. Streaming uses named SSE events and a final done proof; stream EOF alone is not successful completion.
- Documented native SSE may start a thought or Google Search call/result step with an empty signature placeholder and deliver the non-empty signature in a later typed delta. That empty start value is not terminal provider state: replay still requires the completed bounded signature, while null or an empty final/unary signature remains malformed.
- Native function continuations require the provider-returned thought/signature steps. Dropping, merging, or fabricating them can invalidate the next request. They are request-critical private state, not display or logging metadata.
- Stable Interactions accepts `auto`, `any`, `none`, and `validated` tool-choice modes; `any` requires a function call and is the provider mapping for AIQSA's normalized required-tool choice.
- Native Google Search is a hosted `{ "type": "google_search" }` tool. It can produce search call/result steps, URL citation annotations, and exact `search_suggestions` markup. The documentation requires Suggestions to accompany grounded content; current terms constrain storage/use of Search Suggestions and citation Links. Those are external provider facts, not AIQSA route or retention policy.
- Gemini 3 Interactions documents preview support for combining built-in tools such as Google Search with custom functions in one interaction through tool-context circulation. The combined path uses `validated` tool choice because `auto` is unsupported, and continuation-critical step `id` and encrypted `signature` fields must be preserved either by `previous_interaction_id` or by replaying the complete stateless history. The current REST examples target `/v1beta/interactions`.
- Authenticated catalogs contain non-chat image, audio, embedding, and media identifiers. Blind import is unsafe; Quick setup intersects only the reviewed chat candidates above.
- Search Suggestions are provider-supplied markup whose documented and observed shapes may change.

Current catalog intersection, native request mapping, combined-tool policy,
hosted live-only fence, query-only retention, signature handling, and safe smoke
behavior are routed by `BACKEND.md`, `RUN_PIPELINE.md`, `SECURITY.md`, and
focused tests.
