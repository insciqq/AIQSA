# COMPATIBLE OPENAI RUNTIME

Owner: Provider runtime maintainers
Scope: Current AIQSA runtime behavior for compatible OpenAI Responses and Chat Completions adapters.
Read when: Changing compatible protocol selection, storage/lifecycle stripping, streaming usage, no-auth, hosted Search declarations, image-generation declarations, or reasoning mappings.
Code owners: `lib/server/providers/compatibleResponses.ts` and `lib/server/providers/openaiCompatible*.ts`.
Not owned here: Native OpenAI lifecycle behavior, upstream gateway facts, shared admission, or provider-neutral Search execution.

## Compatible OpenAI APIs

Compatible endpoint setup retains the administrator-selected wire protocol and
canonical API root explicitly; it never guesses a missing `/v1` segment or a
protocol from the hostname.

`openai_responses_compatible` uses the Responses wire shape with AIQSA-owned manual context replay, `store=false`, and `background=false`; it strips native OpenAI storage, recovery, prompt-cache, and lifecycle extensions. When an administrator explicitly declares hosted web search, that exact connection owns a separate logical OpenAI Search source whose hosted route is eligible only for answer deployments on the same connection; serialization preserves the standard `web_search` tool, automatic tool choice, source include, artifacts, and citations. Catalog presence and the declaration are not tool-specific verification. The compatible path does not gain native OpenAI retrieve/cancel behavior.

`openai_chat_completions_compatible` uses the Chat Completions wire shape and cannot declare hosted Responses tools. Streaming requests omit `stream_options` by default for endpoint compatibility; the immutable Chat-only `streamUsage` model capability explicitly opts a deployment into `stream_options.include_usage`, while forced non-streaming requests always omit it. Explicit no-auth remains limited to tested private/local endpoint mode, but may use either the declared compatible Chat or Responses transport; no Authorization header is emitted and the safe-fetch/private-network boundary still applies. The optional `nativeImageGeneration` capability is configuration evidence only: current adapters never call a compatible `/images` endpoint and no catalog/composer projection advertises generated-image support until AIQSA has a separate artifact, private-storage, content, and rendering contract.

The compatible Chat response and transport profiles reuse the narrow
OpenAI-compatible Chat Completions core also used by OpenRouter. The compatible
modules retain ownership of endpoint/authentication configuration, no-auth
behavior, reasoning mapping, stream-usage opt-in, and their public error names;
the shared core owns only identical JSON/SSE, tool-call, usage, cancellation,
and bounded-response mechanics.

Both compatible adapters serialize reasoning through the normalized immutable request mapping owned by the server recovery boundary. Chat writes the selected effort to its mapped path and writes `standard | pro` only when an administrator supplied a mode path. Responses retains its canonical reasoning-summary object only for `reasoning.effort` plus `reasoning.mode`; a non-canonical mapping removes that canonical object before setting the mapped values so gateway-specific and OpenAI shapes cannot collide. Transport-owned roots, including `stream_options`, are reserved and cannot be targeted by a reasoning mapping. This bounded mapping does not grant arbitrary body, header, transform, or template authority.
