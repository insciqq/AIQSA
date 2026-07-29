# ADR 0039: Custom Provider Discovery, Hosted Tools, And Lifecycle

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0032-direct-custom-openai-compatible-setup, 0033-unified-providers-workspace-and-lifecycle-state-language

Amendment note: ADR 0042 replaces the id-only/no-capability-import discovery
clause with a strict bounded compatible-model hint contract plus explicit
reasoning and hosted-search choices.

## Context

The first Custom setup contract required a manually typed model ID, fixed every simple setup to Chat Completions, placed Custom below the reviewed provider choices, and left ordinary provider deletion deliberately shallow. In practice, OpenAI-compatible gateways commonly expose a bounded `/models` catalog and may implement Responses hosted tools. A Custom setup also creates direct-user assignments, grants, defaults, a model, and a credential that the management UI cannot all remove independently. That made model entry unnecessarily error-prone, hid replacement activation, and made a newly created Custom connection effectively undeletable.

Catalog membership still cannot prove that an arbitrary row is a runnable chat model or that a hosted tool works. Image generation additionally needs an AIQSA artifact, storage, private-download, assistant-content, and rendering contract that does not yet exist.

## Decision

The Providers task label is **Quick setup**. Custom is the fifth equal-height provider choice, labelled **Custom** with **OpenAI-compatible** context; selecting it opens the isolated Back-connected Custom form rather than pretending it is a reviewed code-owned provider family.

Custom setup is discovery-first with a manual fallback. Active administrators may send the transient endpoint/authentication/key candidate to `POST /api/admin/providers/custom-setup/discover`. The server reuses the SSRF-safe bounded credential catalog probe, calls only the derived `/models` path, and returns at most 1,000 validated ordered unique model IDs plus safe timing/count metadata. The browser ties the result to the current endpoint/authentication/key form state and clears it when those inputs change or the task closes. Discovery persists nothing, imports nothing, infers no capabilities, and never returns remote metadata, endpoint configuration, provider bodies, or secret material.

When discovery returns models, the administrator may explicitly order-select up to 32 IDs; manual fallback remains exactly one ID. **Test & Save** sends one bounded paid tiny-generation request per selected model, sequentially and outside the database transaction. Any failed test writes nothing. Only after every exact model test succeeds does one retry-bounded serializable transaction create the shared connection and credential plus every selected model, availability check, and direct model grant. The first selected model is the conditional default candidate, but an already usable default is never replaced. All selected models share the form's explicit protocol/capability/default configuration, and multiple-model setup uses the exact upstream IDs as initial display names.

Discovered ids use the same searchable picker interaction as large OpenRouter catalogs; the picker does not invent display names or metadata that `/models` did not return. The simple form explicitly selects `chat_completions | responses`. Chat Completions remains the backward-compatible default. Responses maps to `openai_responses_compatible`, remains bearer-only, and keeps stateless manual context replay with `store=false` and `background=false`. Administrators may declare hosted web-search and image-generation support only with Responses. Declared web search sets the existing search capability, grants the acting administrator the existing hosted-search strategy when needed, and makes the standard `web_search` request/source/citation path runnable for compatible Responses. It is an administrator declaration, not tool-specific verification.

The saved Custom connection's `Models` task offers the same transient searchable picker. `discover_compatible_models` resolves the selected stored draft or active credential server-side, reuses the bounded SSRF-safe `/models` probe, and returns id-only rows. An explicit active no-auth credential passes a real null secret into that probe; bearer plaintext and all envelopes remain server-only. Selecting an ID fills one ordinary model draft and imports no capabilities, while the manual upstream-ID field remains available.

Declared image generation is stored as optional capability JSON with missing meaning false. It is explicitly future-facing and is not projected as a runnable chat capability. Implementing it requires a separate generated-image event/artifact/storage/privacy/rendering decision; accepting the declaration alone must never claim AIQSA can generate an image.

Credential drafts remain connection-wide activation inputs. The safe admin projection includes direct-user assignments so readiness and pending-publication logic sees every credential the activation service already treats as authoritative. A saved replacement key exposes contextual **Activate replacement** beside that credential; it invokes the existing exact connection activation rather than inventing a key-only replacement protocol.

Confirmed deletion of a non-template `openai_compatible` connection is a serializable graph operation. It clears model grants, user/chat model defaults, the connection default, user/group credential assignments, checks, credential versions, credentials, and models before deleting the connection. Terminal bindings whose recovery horizon ended retain their immutable execution snapshot and lose live foreign keys through the existing cleanup. Active/recoverable bindings, Run-profile references, model-backed search strategies, and code-owned templates remain hard blockers with actionable conflict kinds. Other provider families retain the conservative non-cascading deletion contract.

## Consequences

- A gateway exposing seven models can offer those seven safe IDs for ordered multi-selection; AIQSA creates all seven only after all seven exact tests pass, without mirroring the arbitrary catalog or inferring capabilities.
- Later model additions to the saved Custom connection use the same searchable id-only discovery interaction as OpenRouter while retaining a manual fallback.
- Compatible Responses gateways may use AIQSA's existing hosted web-search lifecycle and citations when an administrator explicitly declares support.
- Image-capable gateways can record intent without a false chat feature claim or a premature persistence design.
- Direct Custom key rotation has a visible completion action, and direct-user assignments no longer create a false group-assignment blocker.
- An administrator can remove a self-contained Custom connection in one confirmed action while run recovery, profiles, search deployments, code-owned state, and historical snapshots remain protected.

## Required Verification

Deterministic tests cover authorization, exact request shapes, SSRF-safe bearer/keyless discovery, bounds/order/deduplication, secret non-reflection, discovery invalidation/manual fallback, ordered multi-selection, one exact test per selected model, all-or-nothing persistence, conditional first-model defaulting, saved-credential id-only discovery, protocol mapping and invalid combinations, capability round-trip, compatible hosted-search catalog/preparation/admission/request/response behavior, direct-user readiness, contextual replacement activation, serializable Custom graph deletion, and every retained hard blocker. Browser evidence covers the five provider choices, **Quick setup** label, multiple discovered-model selection, the saved Custom Models picker, hosted-tool disclosure, future-only image copy, rotation completion, and confirmation-gated Custom deletion.
