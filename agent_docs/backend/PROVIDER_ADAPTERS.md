# BACKEND PROVIDER ADAPTERS

Owner: Provider runtime maintainers
Scope: Non-normative router to bounded provider runtime contract owners.

This file is a routing index, not a contract owner. Do not add adapter rules here. Read only the shared boundary and provider leaf required by the change.

| Read when | Contract owner |
| --- | --- |
| Provider control plane, entitlements, credentials, catalogs, deletion, immutable run bindings, parameters, or attachment admission | [Admission and bindings](providers/ADMISSION_AND_BINDINGS.md) |
| Common adapter types, HTTP/SSE deadlines, response and stream bounds, cancellation, overflow, previews, usage, or artifacts | [Transport and limits](providers/TRANSPORT_AND_LIMITS.md) |
| Embedding deployment classes, presets, dimensions, query instructions, batching, local MRL truncation, fake vectors, or embedding admission | [Embeddings](providers/EMBEDDINGS.md) |
| Search route planning, hosted/client selection, query validation, tool-loop budgets, fan-out, SearchRun evidence, or query-only privacy | [Provider-neutral client Search](providers/CLIENT_SEARCH.md) |
| Native OpenAI Responses mapping, background lifecycle, streaming, Search serialization, attachments, caching, or reasoning | [OpenAI](providers/OPENAI.md) |
| Compatible Responses/Chat mapping, lifecycle stripping, streaming usage, no-auth, hosted Search declarations, or reasoning mappings | [Compatible OpenAI](providers/OPENAI_COMPATIBLE.md) |
| Anthropic Messages mapping, defaults, thinking, attachments, Search, tool terminals, or continuation | [Anthropic](providers/ANTHROPIC.md) |
| Native Gemini setup, Interactions mapping, signatures, attachments, function tools, hosted grounding, or live-only persistence | [Gemini](providers/GEMINI.md) |
| OpenRouter mapping, downstream routing, streaming, attachments, citations, or Perplexity Search transport | [OpenRouter](providers/OPENROUTER.md) |

Mutable official provider constraints remain routed through [provider API notes](../PROVIDER_API_NOTES.md). Product-level run meaning is routed through [the run pipeline](../RUN_PIPELINE.md), configuration names remain in [environment variables](../ENV_VARIABLES.md), and privacy/security boundaries are routed through [security](../SECURITY.md).
