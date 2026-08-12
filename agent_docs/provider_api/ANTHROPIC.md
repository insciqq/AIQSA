# ANTHROPIC MESSAGES API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official constraints and verified caveats for the Anthropic Messages API.
Read when: Changing Anthropic models, streaming, thinking, attachments, Search, stop reasons, usage, or retention assumptions.
Code owners: `lib/server/providers/anthropicMessages*.ts` and Anthropic provider setup.
Not owned here: AIQSA runtime mapping details, normalized run semantics, or other providers.

## Anthropic Messages API

Last verified: 2026-08-12.

Primary references:

- `https://platform.claude.com/docs/en/about-claude/models/overview`
- `https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5`
- `https://platform.claude.com/docs/en/about-claude/models/migration-guide`
- `https://platform.claude.com/docs/en/build-with-claude/streaming`
- `https://docs.anthropic.com/en/api/messages`
- `https://docs.anthropic.com/en/api/messages-examples`
- `https://docs.anthropic.com/en/api/models-list`
- `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`
- `https://platform.claude.com/docs/en/build-with-claude/pdf-support`
- `https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool`
- `https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools`
- `https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference`
- `https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons`
- `https://platform.claude.com/docs/en/manage-claude/api-and-data-retention`

Externally constrained facts:

- Streaming uses events such as `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, and `message_stop`; clients must tolerate ping/error/unknown event types.
- Content deltas may contain text, tool input JSON, or thinking; usage can appear in events and final message data.
- A bounded live Messages control returned HTTP 200, while the same request with one input `{ type: "text", text: "" }` block returned HTTP 400; replacing that empty block with non-empty marker text returned HTTP 200.
- `refusal` and `model_context_window_exceeded` are successful-response `stop_reason` values rather than HTTP errors. Current documentation specifies an HTTP-200 refusal with empty content and a `message_delta` terminal reason when streaming.
- Total Anthropic input usage is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; current thinking usage is reported as `output_tokens_details.thinking_tokens` when available.
- Older manual thinking uses a token budget below `max_tokens`. Claude Opus 4.8+ uses adaptive thinking plus `output_config.effort`; its documented scale includes `low`, `medium`, `high`, `xhigh`, and `max`, with `high` as API default.
- Client tools use `tool_choice.type=any` to require one supplied tool. Forced tool choice is incompatible with older manual extended thinking, while the current adaptive-thinking path supports it.
- The current explicit Claude 5 API ids are `claude-opus-5` and `claude-sonnet-5`. Both document a 1,000,000-token context window and 128,000 maximum output tokens.
- Claude 5 uses adaptive thinking with effort. Its migration guidance removes manual extended-thinking budgets and non-default sampling combinations for this path.
- PDF/document and image support are model capabilities, not provider-wide assumptions. Direct native PDF input uses Messages document content.
- Authenticated `GET /v1/models` uses `x-api-key` plus the Anthropic version header and returns model identifiers.
- Web Search is a GA Messages server tool. `web_search_20250305` is the basic direct contract; `web_search_20260209` adds dynamic filtering through automatically provisioned code execution, and `web_search_20260318` adds response inclusion controls.
- A direct Search produces a `server_tool_use` paired by id with `web_search_tool_result`; the result carries an explicit `{ type: "direct" }` caller under this contract, while server-tool caller variants identify code-execution paths. Successful results carry URL/title, optional page age, and opaque `encrypted_content`. Text citations carry URL/title, a short cited excerpt, and opaque `encrypted_index`; the opaque values have documented same-provider replay meaning but no documented cross-provider semantics.
- Search operation failures are HTTP-200 result blocks with one of `too_many_requests`, `invalid_tool_input`, `max_uses_exceeded`, `query_too_long`, `request_too_large`, or `unavailable`; an empty result list is successful execution with no matches. Organization-disabled Search instead fails the Messages request with HTTP 400.
- Streaming emits incremental `server_tool_use` input, an atomic complete Search-result block, text/citation deltas, and the ordinary Messages terminal. `pause_turn` requires replaying the complete assistant content with the same model and tools; callers must impose their own continuation cap. Mixing server and client tools introduces the separate deferred-tool lifecycle.
- Usage reports token fields plus `server_tool_use.web_search_requests`. Search is billed per successful use in addition to model tokens. Basic Search is currently ZDR/HIPAA eligible; dynamic filtering is not because it uses code execution. Standard commercial retention and provider trust-and-safety/legal exceptions still apply.

Current AIQSA defaults and request/event normalization live in the [Anthropic runtime owner](../backend/providers/ANTHROPIC.md) and adapter tests.
