# OPENAI RESPONSES RUNTIME

Owner: Provider runtime maintainers
Scope: Current AIQSA runtime behavior for the native OpenAI Responses adapter.
Read when: Changing native OpenAI request/response mapping, background lifecycle, streaming, Search, attachments, caching, or reasoning controls.
Code owners: `lib/server/providers/openaiResponses*.ts` and native OpenAI runtime construction.
Not owned here: Upstream provider facts, compatible gateways, shared admission, or provider-neutral Search execution.

## OpenAI Responses API

OpenAI uses Responses API as the first-class OpenAI path.

`openaiResponses.ts` is the stable adapter facade. `openaiResponsesRequest.ts` owns actual request and always-redacted preview construction; `openaiResponsesResponse.ts` owns status, completed-response, usage/tool/artifact, and SSE normalization; `openaiResponsesTransport.ts` owns authenticated fetch endpoints, timeout composition, JSON parsing, and value-free remote HTTP errors; `openaiResponsesLifecycle.ts` owns provider-specific create/retrieve/poll/retry/refresh/cancel sequencing. Runtime construction and the run engine do not depend on those internal modules.

Current code-owned Claude 5 defaults:

- upstream model and capabilities from the selected active administrator-managed deployment;
- `background=true`;
- `stream=false` unless the per-model Stream control is enabled for the run;
- `store=true`;
- `reasoning.effort=medium`; GPT-5.6 also defaults `reasoning.mode=standard` and advertises its additional `max` effort and `pro` mode only through those models' catalog controls;
- manual context replay, not provider-side chat memory.

Current adapter behavior:

- fetch-based Responses API requests;
- provider-side prompt caching hints always include a hashed per-chat `prompt_cache_key`; pre-5.6 models retain `prompt_cache_retention: "24h"`, while GPT-5.6 uses `prompt_cache_options: { ttl: "30m" }` and never sends both contracts;
- a selected OpenAI Search source whose admitted physical route is hosted adds the `web_search` tool, `tool_choice=auto`, and `include: ["web_search_call.action.sources"]`; the model decides whether to search without an extra backend intent instruction;
- selected client Search plans send the provider-neutral plan tool(s) through Responses, preserve foreground non-streaming custom-tool continuation where required, append `function_call_output` items plus any reasoning/function-call items needed for continuation, persist separately attributed `SearchRun` rows only for actual engine calls, and give the model a final no-tool synthesis call after the allowed tool executions;
- An admitted native PDF becomes a Responses `input_file` block with request-local base64 `file_data`;
- polling retrieve until terminal response when `stream=false`; one separately bounded lifecycle deadline covers create, waits, retrieves, and retry work rather than approximating time with a poll count, while every create/retrieve HTTP exchange retains the accepted connection/model response deadline;
- Responses SSE parsing when `stream=true`, including output-text deltas, web-search lifecycle artifacts, provider response id capture, final usage, and final artifact/citation extraction; only `response.completed` carrying `response.status = completed` proves success, while EOF without that proof is `openai_stream_truncated`; normalized citation artifacts omit URLs that fail the shared external-scheme sanitizer;
- retryable retrieve failures such as `503` are transient artifacts;
- `GET /api/model-runs/:runId` can recover a previously errored background run if stored provider response id later retrieves as completed;
- cancellation uses `POST /v1/responses/:responseId/cancel`.

When UI parameters select `reasoning.effort=none`, AIQSA sends that explicit OpenAI reasoning object. GPT-5.6 `reasoning.mode` is independent and remains serialized when present even with effort `none`. Run validation rejects `max` or `pro` for a model whose catalog controls do not advertise that value. Treat OpenAI `status: incomplete` as a provider failure.

The direct OpenAI default model does not expose or accept `reasoning.effort=minimal` because the low-token provider smoke rejected that value; its current effort options begin at `low`.
