# ADR 0030: Direct Run Controls And Reviewed Provider Catalog

Status: Accepted
Amends: 0011-explicit-next-run-control-ownership, 0016-responsive-composer-disclosure, 0022-admin-managed-llm-provider-control-plane, 0025-clean-slate-research-chat-and-control-center, 0026-personal-provider-quick-setup, 0028-task-first-control-center-and-direct-provider-setup

Amendment note: ADR 0038 keeps the consolidated completed-answer evidence model but gates its settled presentation behind the originating answer's explicit `More` → `Show run details`; message hover/focus/tap reveals only the shared action dock. Direct next-run control ownership is unchanged.

Amendment note: ADR 0031 completely replaces this record's Gemini OpenAI-compatible runtime decision with native stateless Interactions v1 and live-only Google Search grounding. The reviewed Gemini model set and one-key Quick provisioning decision remain in force.

## Context

The clean-slate shell preserved every next-run control behind one complete Run setup disclosure. That kept a single state owner, but it added an unnecessary click to the three choices used most often: concrete model, Fast/Balanced/Deep profile, and search strategy. Completed answers also repeated search and citation summaries as separate stacked disclosures below the terminal run receipt.

Provider Quick setup likewise still described one selected deployment even though current first-party accounts commonly expose several reviewed answer models. Installing only the default forced an administrator back into Advanced for every sibling model. Blindly importing a remote `/models` response is not safe: provider catalogs also contain image, audio, embedding, preview, and otherwise unsupported identifiers whose runtime contract cannot be inferred from a name.

Gemini needs the same one-key path as the other supported providers without introducing a second runtime architecture. Google publishes an OpenAI-compatible Chat Completions endpoint, but its model identifiers, reasoning controls, streaming tool continuation, and thought-signature requirements still need an explicit code-owned compatibility contract.

## Decision

### Direct composer controls

The resting composer exposes four peer actions backed by the existing `composerControlStore` owner:

- **Model** opens the existing searchable entitled-model picker directly.
- Configured **Fast**, **Balanced**, and **Deep** profiles apply their complete model/reasoning tuple with one click.
- **Search** opens the selected model's existing strategy picker directly.
- **More** opens the complete Run setup for reasoning, prompt, generation, response, and presentation controls, including the same Model/Profile/Search editors.

The direct actions and Run setup are two presentations of the same state and actions. They do not create another draft, provider choice, profile identity, persistence path, or request shape. The controls wrap according to available width; a compact viewport may use additional rows but must not hide Model, configured profiles, or Search behind **More**.

Completed-answer search-call counts, citation counts, provider/model identity, terminal status, usage, and warnings share one compact evidence block. Search and citation details expand inside that block. Streaming activity may remain transiently adjacent to the answer, and the existing tool/reasoning disclosures retain their content and visibility preferences; current composer defaults are never used to reconstruct historical evidence.

### Reviewed multi-model Quick setup

Quick policy version 2 supports four code-owned provider families:

| Provider | Recommended default candidate | Other reviewed candidates |
| --- | --- | --- |
| OpenAI | `gpt-5.6-terra` | `gpt-5.6-luna`, `gpt-5.6-sol` |
| Anthropic | `claude-opus-5` | `claude-sonnet-5` |
| Gemini | `gemini-3.6-flash` | `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview` |
| OpenRouter | `anthropic/claude-opus-4.8` | `google/gemini-3.5-flash`, `~google/gemini-pro-latest` |

The bounded authenticated model catalog remains discovery evidence, not configuration authority. Quick setup intersects its normalized identifiers with the current versioned code-owned candidate set and ignores every other row. A new upstream alias or model never becomes runnable or default solely because it appeared remotely.

After testing completes outside the transaction, Quick setup atomically creates or activates every reviewed candidate in that intersection, writes an exact availability check and direct acting-administrator model grant for each, and proves the post-commit catalog exposes all of them. The recommended or explicitly selected candidate alone controls the conditional user-default and untouched run-profile decision. Replacement additionally preserves every already available canonical-connection model under the existing bounded preservation contract. A collision on any candidate is preflighted before writes and returns the safe Advanced boundary; partial multi-model installation is forbidden.

The response may name all newly available reviewed models, but secret handling, direct-user credential assignment, credential precedence, unrelated team/custom state, and the separation between entitlement and credential readiness remain unchanged. Membership in the built-in `Full access` group provides semantic entitlement, but does not select or reveal the tested credential.

### Gemini provider family

`gemini` is a first-class provider family whose code-owned connection uses Google's official OpenAI-compatible root `https://generativelanguage.googleapis.com/v1beta/openai`. Credential testing calls the bounded model catalog and normalizes Google's `models/` identifier prefix before the reviewed-policy intersection.

Gemini answer deployments reuse the existing `openai_chat_completions_compatible` adapter and generic transport/parser. The Gemini family selects a provider-specific tool bridge so provider-neutral calls and results retain `provider = gemini`. Requests use the reviewed per-model max-output and `reasoning_effort` controls, omit unsupported temperature, and never infer native Google Search, native PDF, Live API, media generation, or Interactions state support.

Streaming Chat Completions may attach `extra_content.google.thought_signature` to tool-call deltas. The response accumulator preserves that extension on the assistant tool-call transcript and the next compatible request replays it unchanged with the tool result. Dropping or fabricating a signature is forbidden.

Explicit stable model IDs are preferred over provider aliases that can silently change behavior. Updating the Quick set requires a source change, current official documentation review, bounded account-catalog evidence, adapter/control validation, and focused runtime tests. A low-token real-key smoke may use `GEMINI_API_KEY` from the uncommitted environment and must print only sanitized model/result/usage evidence.

## Consequences

- Frequent run choices are available without opening a modal, while the complete advanced editor and one state owner remain intact.
- Completed answers spend less vertical space on repeated search/citation/run metadata without losing inspectability.
- A single successful provider setup makes every reviewed current answer model seen by that key immediately available to the acting administrator.
- Remote catalogs help discover availability but cannot auto-import unknown runtime capabilities.
- Gemini adds no new provider-neutral run engine or persistence topology; its compatibility differences stay at the family/configuration, request, response, and tool-bridge boundaries.
- Model lists and mutable provider semantics must be reverified when changed; zero pricing placeholders remain compatibility data, not billing truth.
