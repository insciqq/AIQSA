# COMPATIBLE OPENAI API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable constraints and verified caveats for OpenAI-compatible gateways and codex-lb.
Read when: Changing compatible endpoint roots, model discovery, reasoning mapping, hosted Search declarations, or codex-lb integration.
Code owners: `lib/server/providers/openaiCompatible*.ts`, `lib/server/providers/compatibleResponses.ts`, and compatible provider setup.
Not owned here: Native OpenAI lifecycle behavior or AIQSA runtime mapping details.

## Compatible OpenAI Gateways And codex-lb

Last verified: 2026-08-12.

Primary references:

- `https://soju06.github.io/codex-lb/client-setup/`
- `https://github.com/Soju06/codex-lb/blob/main/CHANGELOG.md`

Externally constrained facts:

- codex-lb's OpenAI-compatible client configuration uses the deployment's `/v1` API root. A root that omits `/v1` may resolve to the web application rather than the JSON catalog/API.
- The codex-lb changelog reports an OpenAI-compatible image API backed by its `image_generation` capability from v1.16.0 and forwarding for standalone web search from v1.22.0. Those project capabilities do not prove that a particular deployment, account, or selected model currently enables either tool.
- A successful `/models` catalog request proves only reachability for the supplied authentication candidate. OpenAPI path presence, catalog membership, and declared capabilities do not guarantee that a later tool call will succeed.
- The permitted live deployment smoke returned seven model rows and bounded per-model reasoning metadata, but the shapes are gateway-owned and untrusted.
- The same deployment accepted `reasoning_effort` through both Chat Completions and Responses. A separate Responses request with the hosted `web_search` tool completed with a `web_search_call`; this proves that exact tested deployment/account path, not codex-lb installations generally. Smoke evidence retained only status and output-type facts, never answer text or credentials.
- On the exact tested codex-lb GPT-5.6 Terra path, Responses accepted required custom-tool choice yet intermittently completed with reasoning/no callable output or incomplete arguments; earlier Chat Completions qualification for the same model had no structural verifier failures. Tool reliability is therefore protocol- and deployment-specific, not proved by model identity or a generic tool-capability flag.

Current compatible protocol selection, discovery allowlisting, reasoning
mapping, Search publication, and image-generation declarations live in the
[compatible runtime owner](../backend/providers/OPENAI_COMPATIBLE.md) and focused tests.
