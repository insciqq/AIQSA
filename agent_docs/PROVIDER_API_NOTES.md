# PROVIDER_API_NOTES

Owner: Provider integration maintainers
Scope: Non-normative router to bounded external provider contract owners.

This file is a routing index, not a contract owner. Do not add provider facts or runtime rules here. For provider-facing work, read the shared ownership boundary and only the affected provider leaf.

| Read when | Contract owner |
| --- | --- |
| Any provider-facing change; cross-provider memory, continuation, attachment, verification, or evidence boundaries | [Ownership and cross-provider boundaries](provider_api/OWNERSHIP_AND_BOUNDARIES.md) |
| Native OpenAI Responses models, lifecycle, Search, reasoning, caching, or attachments | [OpenAI Responses](provider_api/OPENAI_RESPONSES.md) |
| Compatible OpenAI gateways, codex-lb, discovery, reasoning mappings, or declared hosted Search | [Compatible OpenAI](provider_api/OPENAI_COMPATIBLE.md) |
| Anthropic Messages models, streaming, thinking, attachments, Search, stop reasons, usage, or retention | [Anthropic](provider_api/ANTHROPIC.md) |
| Native Gemini models, Interactions, streaming, signatures, tools, grounding, Search, or attachments | [Gemini](provider_api/GEMINI.md) |
| OpenRouter catalogs, downstream routing, reasoning, streaming, Perplexity Search, citations, or PDFs | [OpenRouter](provider_api/OPENROUTER.md) |
| Remote MCP OAuth, hosted Notion, protected-resource discovery, upstream redirects, or brokered SaaS | [MCP OAuth and brokered SaaS](provider_api/MCP_OAUTH.md) |

AIQSA runtime behavior is routed separately through [backend provider adapters](backend/PROVIDER_ADAPTERS.md). Product-level run semantics are routed through [the run pipeline](RUN_PIPELINE.md), configuration names remain in [environment variables](ENV_VARIABLES.md), and provider/security boundaries are routed through [security](SECURITY.md).
