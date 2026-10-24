---
paths:
  - "lib/server/providers/**"
  - "lib/server/providerRuntime/**"
  - "lib/server/admin/providers/**"
  - "lib/server/search/**"
  - "lib/server/speechToText/**"
  - "lib/server/vision/**"
---
# Providers

Model providers, roles, capability evidence, transports, Search, embeddings, reranking and prices. Adapters: `lib/server/providers/`; role resolution and execution: `lib/server/providerRuntime/`; administrator setup and capability checks: `lib/server/admin/providers/`. Run behavior is in `agent_docs/RUN_CONTRACTS.md`, endpoint security in `agent_docs/SECURITY.md`.

## Authority and roles

- Catalog discovery shows availability; it never authorizes execution. Admission checks and binds the exact tested connection, model revision, credential and role, and the run keeps them without rechecking before each request (`agent_docs/RUN_CONTRACTS.md`).
- Chat models must have verified tool calling; models without it are not offered for chat (operator decision 2026-10-22). Roles that need no tools, such as Search or Decisions, are exempt.
- Personal credentials resolve as: the user's direct grant, then an identical group grant, then an explicitly configured installation default.
- Answer, embedding, rerank, Vision, Decisions and other internal roles are independent. Internal roles run on installation credentials, grant users nothing, and never borrow another role's assignment.
- Image generation is a published resource: administrators publish verified models and keep one default, without which image generation is off for everyone. Users may pick a published model. An unusable published model is marked, never substituted.
- Optional Decisions need their own disclosure, qualification and verified availability; adopting them preserves explicit choices, and a failed adoption needs explicit repair, never an automatic replay or a startup block.
- Speech to text binds a connection and an upstream model id; only a passing Test with the bundled synthetic sample saves it, bound to the tested key version. Dictation audio and transcripts exist only within the request.

## Capability evidence

- A capability counts only after a successful probe on the exact active connection, model, credential and route; names and metadata prove nothing. Structured output, strict Memory actions, image input and PDF input are proven independently.
- Add provider, Add model and Test & Save run every implemented probe for the model class (direct PDF included) and publish each success with its enabled flag on the exact tested revision. A partial failure keeps usable models and proofs.
- Bootstrap creates one built-in connection per family. Until it has a key or was activated it is a placeholder, not a connection: lists leave it out, and the family's first Add provider configures it under the chosen name with its built-in Search sources (operator report 2026-10-23, `lib/domain/providerTemplates.ts`).
- On a connection with a single enabled key, every later check of the live model revision turns on each capability it verifies and never turns one off because a probe failed or was skipped (operator decision 2026-10-15). So a recheck can re-enable what an administrator switched off; only the check right after the administrator's own model save keeps the saved flags, and discovery never re-enables anything.
- A Codex LB context window comes from the exact connection's catalog listing (`context_length` or `context_window`, never `max_context_window`; operator decision 2026-10-22), with the template value only as a fallback. Setup and later checks replace only a missing or template-default window; any other value is the administrator's and is kept (`lib/server/admin/providers/codexLbContextWindow.ts`).
- Only a deterministic rejection or a static adapter restriction proves incompatibility. Authentication, rate-limit, network, timeout, output or context safety-limit and upstream failures keep the previous evidence. Native PDF proof must read image content through the native route; intermediary OCR text, refusals and generic HTTP errors are inconclusive.
- Changing an endpoint requires fresh secrets for every retained key, disabled ones included, before contacting the new destination. A stored secret is never sent to a changed endpoint, so editing a URL cannot leak a saved key.
- Gemini structured-output schemas omit upper bounds on nested arrays for compatibility; consumers enforce the canonical bounds after decoding.

## Transport

- Every transport bounds input and output, supports cancellation, requires exact terminal proof and reports failures without values. Raw requests, responses, reasoning, tool arguments and provider errors are never kept for diagnosis.
- A run's model calls retry transparently on every provider (answer first, `agent_docs/RUN_CONTRACTS.md`): network errors, rate limits, server errors and streams that drop before terminal proof are re-sent unchanged to the same destination with the same authority, bounded, with backoff, under Stop and within the turn's deadline. The failed attempt's partial output is discarded, and a round's tool calls run only after the round completes, so a retry never repeats a tool effect. Deterministic rejections are not retried. Every physical request, retries included, is accounted; accepted cost: a failed attempt may be billed too. The existing classification is in `lib/server/providers/providerRetry.ts`.
- Custom endpoints need an explicit protocol and the canonical base URL; never guess `/v1`. Public endpoints need HTTPS and bearer authentication; private HTTP and no-auth endpoints need their reviewed flags and pinned DNS and redirect checks.
- Native and compatible protocols are different runtimes with no fallback between them; compatible Responses inherits no store, background or cache lifecycle. DeepSeek and Gemini use native paths only. Gemini thought signatures stay private continuation state.
- Anthropic thinking blocks are private continuation state too: they replay whole, only to the route and model that produced them and only within the current turn. Anthropic rejects a replayed block once anything sent before it changed (preserved thinking, enforced for accounts created from 2026-08-31), and the engine's requests are not append-only, so the renderer replays only an unbroken run of blocks whose recorded prefix still holds and drops the rest (`lib/server/providers/anthropicMessagesHistory.ts`).
- Gateway routing keys are opaque and never idempotency keys. On a compatible Responses connection with request isolation (Codex LB, whose upstream sessions handed concurrent requests that shared a key each other's results), no two requests that may be in flight at once share a key: a native run's model calls share a stable key per lane of their chat (the loop's rounds; each run's own compactions, which run beside the loop and may outlive the run), so the gateway's prompt cache can hit; a failed request moves its lane to another key; every other request, replays included, gets a fresh one (decision 2026-10-23, `lib/server/providers/gatewayRouting.ts`).
- OpenRouter routes to a discovered native provider without outside fallback unless the operator chose otherwise. Data collection defaults to `deny`; `allow` is a per-model administrator choice, checked at admission.

## Search

- A Search engine receives only a bounded generated query and server-owned controls, never the conversation, prompts, attachment identity, file names or extracted text. Raw result bodies and recursively discovered URLs are not kept, and no unselected engine runs as a fallback.
- Search is on for everyone (operator decision 2026-10-24). An organization default without a source resolves to the first usable source in the priority of `automaticSearchOptionId` (`lib/domain/search.ts`); there is no organization Off, and a chosen source that becomes unusable is never replaced. Every search goes to all selected sources.
- Every chat model calls tools, and only OpenAI hosted Search runs inside such an answer; every other source searches through its client route, a separate request to the source's technical model. Catalog, admission and administrator readiness share this rule (`hostedSearchProtocolUsable`).
- The DeepSeek Search API is DeepSeek's only Search source (operator decisions 2026-10-18 and 2026-10-24): offered to every tool-calling answer model and enabled by provider setup after one result-bearing probe. DeepSeek's hosted Search is retired, because live checks showed V4 Flash never searching through it and no model returning source links. DeepSeek reports no cost, so a result-bearing request is billed at the published per-request price, an empty or rejected one costs nothing, and an unreadable one stays unknown (`lib/server/providers/deepSeekSearchApi.ts`).

## Documents, embeddings and reranking

- Chat PDF work freezes its own admitted destination and evidence. A failed model route never switches silently to local extraction or another provider.
- Vector spaces never mix, an invalid vector rejects the whole batch, and reusing an older generation needs proof of the same canonical vector space, not a matching model name.
- A reranker receives a sanitized query and documents behind opaque handles and returns scores only. Coverage must be complete and one-to-one, and a broken selected reranker never falls through to an unselected one or the System Model.

## Prices and usage

- Forward migrations never overwrite an administrator's token price: they update only `catalog` rows or unknown prices, matched by `providerModelCatalogKey` (`lib/server/admin/providers/providerModelPricing.ts`), and prices never synchronize at startup.
- A paid call takes the provider-reported cost (OpenRouter BYOK adds the upstream cost), else the model's class prices, else stays unknown. Every paid call that returned usage is recorded once with its purpose, failed calls, retries and administrator checks included; a run records it after its answer (`agent_docs/RUN_CONTRACTS.md`).

## Upstream references

Recheck primary documentation when changing provider behavior; adapter tests own the exact wire support.

- OpenAI: [Responses](https://platform.openai.com/docs/api-reference/responses), [background mode](https://platform.openai.com/docs/guides/background), [SDK retries](https://github.com/openai/openai-node/blob/main/docs/configuration.md#retries-and-timeouts).
- DeepSeek: [Responses](https://api-docs.deepseek.com/api/create-response/).
- Gemini: [Interactions](https://ai.google.dev/api/interactions-api-v1), [Google Search](https://ai.google.dev/gemini-api/docs/google-search).
- OpenRouter: [routing](https://openrouter.ai/docs/guides/routing/provider-selection), [structured output](https://openrouter.ai/docs/guides/features/structured-outputs), [embeddings](https://openrouter.ai/docs/api/reference/embeddings), [reranking](https://openrouter.ai/docs/api/api-reference/rerank/create-rerank), [speech to text](https://openrouter.ai/docs/guides/overview/multimodal/stt).
- MCP: [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
