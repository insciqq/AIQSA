# PROVIDER EMBEDDINGS

Owner: Provider runtime maintainers
Scope: Embedding deployment configuration, admission, transport, vector-shape normalization, and deterministic test behavior.
Read when: Changing embedding presets, model-class separation, `/embeddings` transport, dimensions, query instructions, activation catalogs, grants, or embedding tests.
Code owners: `lib/domain/embeddingModels.ts`, `lib/server/providers/embeddings.ts`, `lib/server/providerRuntime/embeddingRuntime.ts`, and embedding branches of provider administration.
Not owned here: Knowledge Base schema/ingestion/retrieval, reranking, multimodal inputs, answer-model transport, or mutable upstream facts.

## Deployment And Authority

`ProviderModel` is the shared deployment aggregate for answer and embedding
models. Its persisted `modelClass` is `answer` or `embedding`, defaults existing
rows to `answer`, and is immutable after creation. The normalized draft/active
configuration carries the same discriminator. An embedding deployment uses
only `openai_embeddings_compatible`, is never answer-selectable, has inert
answer capabilities/default parameters, and pins its owning connection family
as `openai`, `openai_compatible`, or `openrouter`. Family validation rejects a
deployment attached to a different connection.

Connections, immutable credential versions, direct-user/group/default
credential precedence, activation checks, enabled state, and `AccessGrant`
rows remain shared. Embedding admission requires an active enabled embedding
row and connection, a direct model or provider grant (or the built-in
`full_access` wildcard), one resolved usable credential, and the current exact
available `(connection version, model version, credential version)` check.
The bearer value is decrypted from that exact non-revoked version immediately
before a request. Answer catalogs/admission and answer/technical Search paths
filter `modelClass = answer`; embedding rows never become chat defaults,
Assistant targets, system-model candidates, or answer catalog entries.

OpenRouter activation and diagnostics inspect its dedicated embedding-model
catalog for embedding rows and its account-filtered answer catalog for answer
rows. Evidence stays class-specific even when one connection contains both.
Other compatible families use their `/models` catalog for exact-id activation
membership. A failed or absent exact id produces unavailable evidence; no
alternate model is considered.

## Configuration And Presets

Every embedding configuration declares `nativeDimension`, `targetDimension`,
`supportsMrl`, and a nullable query instruction template containing exactly one
`{text}` placeholder. Target dimensions are positive, no greater than the
native dimension, and capped at 2,000 for the indexed Knowledge vector shape.
When `supportsMrl` is false, target and native dimensions must be equal.

The reviewed presets are:

| Connection | Deployment id | Native → target | MRL | Query behavior |
| --- | --- | ---: | --- | --- |
| OpenRouter (default) | `qwen/qwen3-embedding-8b` | 4096 → 1536 | yes | retrieval instruction on queries; documents bare |
| OpenRouter | `google/gemini-embedding-2` | 3072 → 1536 | yes | symmetric text input |
| OpenRouter | `baai/bge-m3` | 1024 → 1024 | no | symmetric text input |
| OpenAI | `text-embedding-3-large` | 3072 → 1536 | yes | symmetric text input |

Presets are starting configurations, not quality or billing claims. The
administrator adds or re-enables them in the existing Models task. The
deployment list exposes its vector shape and class; embedding class cannot be
edited into an answer class or vice versa.

## Request And Response Contract

One adapter call accepts 1–128 non-empty texts, at most 131,072 characters per
text and 2 MiB of serialized request data. Query mode expands the configured
template; document mode sends each original text unchanged. The adapter posts
one JSON request to the configured origin's exact `/embeddings` path with the
exact model id and `encoding_format: "float"`. It never sends a provider
`dimensions` value and never retries another endpoint or model. OpenRouter
requests additionally set denied data collection and `allow_fallbacks: false`.

Buffered responses retain the global provider-body ceiling with an additional
fixed 16 MiB embedding cap. Success requires the exact response model id, one
unique indexed vector per input, the declared native dimension, and only
finite numeric components. AIQSA then takes the first target components and
L2-normalizes every vector, including native-sized output. A zero/non-finite
norm, wrong count/dimension/model, malformed usage, oversized body, HTTP
failure, or deadline failure closes with a stable `embedding_*` code. Usage
captures provider `prompt_tokens`/`input_tokens` and `total_tokens`, including
valid zero values, without treating it as billing truth.

Hermetic tests use `createFakeEmbeddingAdapter`. It hashes the seed and exact
prepared input into deterministic native components, then applies the same
truncate-and-normalize rule and local token approximation. It performs no
network I/O; query/document asymmetry remains observable because prepared text
is part of the seed.

Mutable model and endpoint facts live in [embedding API notes](../../provider_api/EMBEDDINGS.md). Knowledge persistence and retrieval remain out of this contract.
