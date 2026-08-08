# EMBEDDING API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official embedding protocol and reviewed model constraints.
Read when: Changing embedding endpoints, model catalogs, presets, dimensions, shortening, context limits, query instructions, usage, or OpenRouter embedding transport.
Code owners: `lib/domain/embeddingModels.ts`, `lib/server/providers/embeddings.ts`, `lib/server/providers/openRouterDiscovery.ts`, and provider activation tests.
Not owned here: AIQSA admission, local bounds/error mapping, Knowledge schema, retrieval quality, or billing truth.

## Verified Constraints

Last verified: 2026-08-08.

Primary references:

- `https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings`
- `https://openrouter.ai/docs/api/reference/embeddings`
- `https://openrouter.ai/docs/api/api-reference/embeddings/list-embeddings-models`
- `https://openrouter.ai/qwen/qwen3-embedding-8b/api`
- `https://openrouter.ai/google/gemini-embedding-2`
- `https://openrouter.ai/baai/bge-m3/api`
- `https://huggingface.co/Qwen/Qwen3-Embedding-8B`
- `https://huggingface.co/BAAI/bge-m3`
- `https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2`
- `https://developers.openai.com/api/docs/guides/embeddings`

Externally constrained facts:

- OpenRouter accepts OpenAI-shaped batched `POST /api/v1/embeddings` requests and exposes embedding discovery at `GET /api/v1/embeddings/models`. The request supports `model`, `input`, `encoding_format`, optional `dimensions`, optional `input_type`, and provider routing. Embeddings are non-streaming. Response entries are indexed vectors; usage reports prompt and total tokens and may validly contain zero on a cache hit.
- `qwen/qwen3-embedding-8b` has a 32K input context, native 4096-dimensional output, MRL dimension flexibility, and instruction-aware query behavior. Qwen's official guidance applies the task instruction to queries and leaves documents unprefixed; omission can reduce retrieval quality.
- `google/gemini-embedding-2` exposes a stable 8192-token text input limit and native 3072-dimensional output with supported reduced sizes from 128 through 3072; Google recommends 768, 1536, or 3072. OpenRouter currently exposes the exact `google/gemini-embedding-2` id.
- `baai/bge-m3` documents 8192-token inputs and 1024-dimensional output. Its reviewed official card does not document MRL shortening, so AIQSA treats 1024 as fixed rather than inferring truncation support. OpenRouter currently exposes the exact `baai/bge-m3` id.
- OpenAI documents `text-embedding-3-large` with 8192-token inputs and 3072 dimensions by default. The v3 embedding family is trained for shortened vectors; OpenAI's manual-shortening example normalizes after truncation.

Optional dimension parameters and routing capability are provider facts, not
AIQSA policy. The [embedding runtime owner](../backend/providers/EMBEDDINGS.md)
defines full-vector requests, local truncation/normalization, exact endpoint
and model behavior, and no fallback.
