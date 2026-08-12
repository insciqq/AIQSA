# OPENAI RESPONSES API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official constraints and verified caveats for the native OpenAI Responses API.
Read when: Changing native OpenAI Responses models, background lifecycle, Search, reasoning, caching, or attachment transport.
Code owners: `lib/server/providers/openaiResponses*.ts` and native OpenAI provider setup.
Not owned here: AIQSA runtime behavior, configuration names, normalized run semantics, or compatible gateways.

## OpenAI Responses API

Last verified: 2026-08-12.

Primary references:

- `https://platform.openai.com/docs/api-reference/responses`
- `https://platform.openai.com/docs/api-reference/models/list`
- `https://developers.openai.com/api/docs/guides/migrate-to-responses`
- `https://platform.openai.com/docs/guides/background`
- `https://developers.openai.com/api/docs/guides/tools-web-search`
- `https://developers.openai.com/api/docs/guides/prompt-caching`
- `https://platform.openai.com/docs/guides/reasoning`
- `https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters`
- `https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode`
- `https://developers.openai.com/api/docs/models/gpt-5.6-sol`
- `https://developers.openai.com/api/docs/models/gpt-5.6-terra`
- `https://developers.openai.com/api/docs/models/gpt-5.6-luna`
- `https://developers.openai.com/api/docs/guides/file-inputs`

Externally constrained facts:

- OpenAI recommends Responses for new projects while Chat Completions remains supported. They have different input/output, streaming, tool, structured-output, and state contracts; OpenAI compatibility alone does not establish which endpoint a third-party service implements.
- Background Responses use `background: true`, are retrieved/cancelled by response id, and require stored provider state. This stored/background path is not Zero Data Retention compatible. OpenAI documents polling storage on roughly a ten-minute horizon.
- Background creation may also stream. Responses SSE and terminal payloads can expose output deltas, web-search lifecycle/source data, usage, and the response id.
- Reasoning controls live under `reasoning`; `max_output_tokens` includes visible output and reasoning tokens. Reasoning summaries use `reasoning.summary`; older `generate_summary` is deprecated.
- GPT-5.6 has the concrete `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` model ids. Each documents a 1,050,000-token context window and 128,000 maximum output tokens.
- GPT-5.5 likewise documents a 1,050,000-token context window and 128,000 maximum output tokens; `1m` is only shorthand, while catalog and UI limits retain the exact value.
- GPT-5.6 supports efforts `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Its independent `reasoning.mode` is `standard` by default or `pro`; Pro is not a separate model slug and trades additional latency, tokens, and cost for more work.
- The reviewed direct-model effort list for `gpt-5.5` excludes `minimal` and documents `medium` as its default.
- Explicit effort `none` is materially different from omitting the reasoning object for a reasoning-default model. A terminal `status: incomplete` is not a complete answer.
- Authenticated `GET /v1/models` returns the model identifiers available to the key; catalog presence does not guarantee that a later generation will succeed.
- Ultra-small generation diagnostics are not portable across current models and routes.
- Native `web_search` uses the Responses tool contract and may return call/action sources and/or message annotations. It does not require a backend regex intent gate.
- Responses function tools accept `tool_choice=required`; with one function and parallel calls disabled, that requires exactly one function call.
- A foreground, non-streaming Responses request can use `web_search` with `store: false` without requiring stored/background response state.
- Native `web_search` and parallel custom functions can coexist.
- Prompt caching is automatic where eligible; `prompt_cache_key` and retention hints influence routing/retention and must not expose a raw local chat id. GPT-5.6 replaces the older `prompt_cache_retention` field with `prompt_cache_options`; its currently documented TTL is `30m`.
- Image input may use URLs, data URLs, or provider file ids where the model supports vision. Native PDF file input is model-capability dependent, and direct PDF parsing includes both extracted text and page images in context; provider-hosted File Search/vector stores are a separate provider-specific product from direct file input.

Current AIQSA request construction, polling, tool bridging, attachment mapping, redaction, and normalized event/result behavior live only in the [OpenAI runtime owner](../backend/providers/OPENAI.md) and adapter tests.
