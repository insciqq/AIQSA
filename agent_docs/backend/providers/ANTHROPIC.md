# ANTHROPIC MESSAGES RUNTIME

Owner: Provider runtime maintainers
Scope: Current AIQSA runtime behavior for the Anthropic Messages adapter.
Read when: Changing Anthropic request/stream mapping, defaults, thinking, attachments, Search, tool terminals, or continuation.
Code owners: `lib/server/providers/anthropicMessages*.ts` and Anthropic runtime construction.
Not owned here: Upstream Anthropic facts, shared admission, or provider-neutral Search execution.

## Anthropic Messages API

Anthropic uses Messages API with streaming.

Current defaults:

- upstream model and capabilities from the selected active administrator-managed deployment;
- `maxTokens=128000`;
- `outputConfig.effort=high`;
- adaptive thinking enabled with the model's reviewed effort control; sampling controls remain unavailable for these deployments.

Current adapter behavior:

- fetch-based Messages API streaming requests;
- system and developer prompt drafts are combined into top-level `system`;
- An admitted native PDF becomes a Messages `document` block with a base64 source;
- attachment-only history consumes the shared non-empty marker projection from [runs and streaming](../RUNS_AND_STREAMING.md), so Messages never receives a fabricated empty text block;
- thinking controls map to Anthropic thinking/output config fields where supported;
- provider SSE events map text deltas to tokens, thinking deltas to reasoning artifacts, citations and hosted Search activity to bounded normalized artifacts, and cumulative usage to run usage; `message_stop` is required before the adapter returns success, and prior EOF is `anthropic_stream_truncated`. On the ordinary non-hosted path, `end_turn`, `max_tokens`, `stop_sequence`, and the existing no-`message_delta` shape succeed only when no client tool call was parsed; parsed client tool calls require `tool_use`, which itself requires at least one call. Any mismatched terminal fails before the tool loop can execute it; `refusal` and `model_context_window_exceeded` fail as `anthropic_message_<stop reason>`; and `pause_turn` remains unexpected;
- `anthropic-web-search` is one connection-owned logical source. Eligible same-connection answers use hosted Search only when no app/MCP client tools must coexist; otherwise admission selects its exact-model query-only route. Both routes pin `{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_callers: ["direct"] }`, and request construction rejects mixing that hosted tool with client tools;
- query-only Search is non-streaming and receives only the validated query, fixed instruction, exact technical model, bounded output/effort policy, and server tool. It requires an observed successful operation, bounded findings, and safe citations. The cumulative provider-reported Search request count is retained only as bounded normalized usage. Raw result/error bodies and opaque `encrypted_content`/`encrypted_index` never become previews, artifacts, logs, SearchRun data, or downstream context;
- `pause_turn` continuation replays the complete provider assistant content with the identical tool inside one live adapter deadline, for at most three continuation requests. Opaque replay fields remain in memory only; an interrupted partial continuation is not checkpointed or repeated automatically, while settled query-only calls retain the ordinary tool-result recovery path.
