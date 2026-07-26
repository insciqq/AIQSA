# ADR 0026: Personal Provider Quick Setup

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0024-admin-managed-run-profiles

Amendment note: ADR 0028 retains the one-key Quick workflow but replaces its isolated Primary/default-credential graph with an actor-relative direct-user credential assignment. Existing team/custom state is nonblocking, and `advanced_required` is now limited to a canonical identity/configuration collision that Quick cannot reconcile losslessly. ADR 0030 replaces policy v1's three-provider, one-deployment/one-grant result with policy v2 across OpenAI, Anthropic, Gemini, and OpenRouter: every remotely visible reviewed candidate is installed and granted atomically, while one selected candidate still owns default/profile decisions.

## Context

ADR 0022 deliberately exposes the full provider control plane: connections, credentials, model deployments, checks, assignments, drafts, and activation. That surface is necessary for team and enterprise installations, but it makes the first-run path needlessly indirect for an administrator running AIQSA for themselves.

The common personal setup already has all of the information needed for a smaller workflow:

1. The administrator has an API key for a known provider.
2. They choose that provider in Admin -> Providers.
3. They enter the key and ask AIQSA to test and save it.
4. AIQSA establishes a usable personal default without asking them to create or edit a group.

This workflow must not weaken the control-plane invariants. In particular, a credential is not an entitlement, a model entitlement is not permission to use an arbitrary credential, remote I/O must not run inside a database transaction, and an unsuccessful replacement must not damage an already working provider graph.

## Decision

### Two provider-management surfaces

Admin -> Providers presents two levels of provider management:

- **Quick setup** is the default personal path for the code-owned OpenAI, Anthropic, and OpenRouter provider templates.
- **Advanced** exposes the complete connection, credential, model, assignment, validation, and activation workflows defined by ADR 0022.

These are two views over the same provider control-plane contracts, not two independent configuration systems. Quick setup does not create a shadow provider registry or a second source of truth.

Quick setup owns `GET` and `POST /api/admin/providers/quick-setup`. `GET` is the secret-free, active-administrator status and eligibility projection; `POST` is the only mutation and performs the complete test-and-save orchestration. Opening Providers loads only that Quick projection. The legacy Advanced provider and run-profile resources are mounted and loaded only after the administrator explicitly opens **Advanced**. The browser never composes Quick setup by calling the Advanced mutation routes in sequence.

The Providers navigation label and client-side subview representation remain frontend routing decisions. Quick and Advanced do not become new top-level Control Center destinations.

### Quick setup flow

For a provider that is eligible for Quick setup, the primary flow is:

1. Select the code-owned provider.
2. Enter an API key in a write-only field.
3. Select **Test & Save**.
4. Receive **Ready** only after the resulting model is present in the acting administrator's current-user filtered catalog.

Quick setup performs a bounded, read-only provider catalog request through the provider-specific adapter. It applies the existing outbound-request safety, timeout, redirect, response-size, and result-count limits. It must not perform a paid generation, embedding, image, audio, or other billable inference request. Any explicit generation diagnostic remains an Advanced action with its own confirmation.

The API key remains a write-only candidate throughout the flow. The server validates and normalizes the bounded candidate once, uses that exact normalized value for both the remote catalog request and the candidate envelope, and persists the envelope only in a successful commit. The key is never returned by an API, copied into a response, logged, included in an event, or interpolated into an error.

### Deterministic model selection

Each Quick-supported provider has a code-owned, versioned recommendation policy. The policy maps a bounded catalog result to one supported code-owned answer-model configuration. Its ordered candidates and compatibility requirements are reviewable source-controlled data.

The recommendation must never be derived from the first remote row, remote ordering, alphabetical ordering, an untrusted popularity or pricing field, or a guess based on a model name. A newly appearing remote model cannot become the personal default until a code change explicitly adds it to the supported recommendation policy.

Quick policy version 1 is binding:

| Provider | Recommended candidate | Ordered picker candidates when the recommendation is absent |
| --- | --- | --- |
| OpenAI | `p1-o1` -> `openai:gpt-5.6-terra` | `p1-o2` -> `openai:gpt-5.6-luna`; `p1-o3` -> `openai:gpt-5.6-sol`; `p1-o4` -> `openai:gpt-5.5` |
| Anthropic | `p1-a1` -> `anthropic:claude-opus-4-8` | none |
| OpenRouter | `p1-r1` -> `openrouter:anthropic/claude-opus-4.8` | `p1-r2` -> `openrouter:google/gemini-3.5-flash`; `p1-r3` -> `openrouter:~google/gemini-pro-latest` |

Candidate IDs are code-owned opaque protocol values. The browser may submit and compare them but must not parse them, derive provider/model identity from them, or replace them with a database deployment ID or remote model ID. A candidate matches only when the bounded catalog contains its exact configured upstream model ID and the code-owned template/configuration remains valid for that canonical provider. Policy v1 has one automatic recommendation per provider; picker candidates are never silent fallbacks. `openrouter:perplexity/sonar-pro-search` is a technical search deployment and is never an answer recommendation or picker choice.

Initial Quick setup creates or reuses and activates exactly one selected answer deployment, creates exactly one model-specific direct grant for the acting administrator, and leaves every other code-owned model absent or disabled as it was. It does not create a provider-wide grant or hidden secondary answer/search deployment.

If no recommended candidate is present, Quick setup returns a compact `selection_required` result containing only the intersection of:

- models observed in the bounded catalog response; and
- code-owned model configurations that AIQSA can safely activate.

The intersection is ordered by the provider's picker order above, never by the remote response. Anthropic has no fallback picker: if `p1-a1` is absent, the intersection is empty.

`selection_required` performs no durable write. The response contains `policyVersion: 1` plus only safe display data and the opaque candidate IDs for the nonempty intersection. The server does not retain the submitted key, catalog evidence, a draft credential, or a partial provider graph. The browser may retain the still-masked local form value while the administrator chooses a model. The subsequent **Test & Save** submission includes the returned policy version and candidate ID and repeats the complete bounded remote check before it may commit. An unknown/stale policy or candidate, or a selected candidate no longer present after that repeated check, produces a no-write safe conflict/failure rather than another model being chosen silently. An empty intersection is a post-catalog `provider_quick_setup_unsupported_catalog` failure with an Advanced CTA; it is not the GET persisted-state classification `advanced_required`.

### Remote validation and atomic commit

The service loads a server-owned eligibility/fence snapshot before remote validation. All provider network I/O completes before the database transaction begins and is never repeated by a transaction retry. After the remote result is available, Quick setup opens a short `SERIALIZABLE` transaction, takes the structured locks below, rechecks administrator authorization and the complete expected persisted state, and either commits the complete plan or commits nothing. A relevant provider, credential, model, direct-grant, user-default, or affected-profile change that wins before those locks makes the request `stale`; the service does not silently merge over it. Serialization/unique conflicts from a competing Quick or Advanced write are mapped to the same safe stale result after bounded database-only retry. A mutation serialized after the Quick commit is a later control-plane change and does not retroactively change the completed response.

Every Quick initial/recovery/replacement commit uses one lock order:

1. acting `User` row, then its `UserSettings` row;
2. every same-family `ProviderConnection` contender in stable ID order;
3. their relevant credentials, versions, models, checks, assignments, and direct acting-user grants in stable ID order; and
4. fixed `RunProfile` rows in `fast`, `balanced`, `deep` order only when an initial commit may fill a profile.

Quick locks existing parent/child rows, performs exact predicate/count rechecks for absent or extra child state inside the serializable snapshot, and relies on existing foreign-key/unique conflicts to settle competing Advanced writes; this ADR does not claim that every existing Advanced writer already takes the new Quick lock sequence. The existing all-profile editor already locks all fixed profile rows in a stable order. Quick checks and creates/reuses the exact acting-user/model grant while holding the acting-user row, so concurrent/repeated Quick requests cannot duplicate it. Any future writer that exercises the direct-user model-grant seam must join the acting-user lock protocol or accept a separate schema decision.

For initial setup, one fenced atomic commit establishes:

- the enabled canonical connection for the chosen code-owned provider;
- connection credential policy `use_default`;
- an enabled credential named `Primary`, its encrypted active credential version, and the connection's default-credential reference;
- exactly one selected supported answer-model deployment and its active version;
- one sanitized authoritative availability check that matches the tested candidate credential version and selected model version;
- exactly one enabled direct, model-specific entitlement grant for the acting administrator;
- the acting administrator's default model, but only when their prior default is null or unusable; and
- at most one mapping for the exact existing code-owned run-profile recipe whose target template is the selected model and whose slot is still provably untouched.

The same transaction evaluates the current-user catalog eligibility predicate for the acting administrator. It may commit only if that projection contains the selected personal model. The endpoint returns **Ready** only from that proven persisted state.

Quick setup never creates, renames, adds members to, assigns credentials to, or grants models to a group. It grants no entitlement to another user.

Entitlement and credential resolution remain separate:

- the direct user grant authorizes the acting administrator to use a specific model deployment;
- `use_default` resolves that deployment to the connection's default active credential; and
- neither fact implies the other or authorizes any other provider model.

Quick setup does not introduce or authorize direct-user credential assignment. Team-specific credential selection continues to use the assignment rules from ADR 0022 in Advanced.

"Safe defaults" in this workflow means only the conditional acting-user default-model update above. Quick setup does not change the user's search default, prompt, control-value drafts, presentation settings, chat defaults, search grants, or any unrelated provider's configuration or access.

### Existing defaults and profiles

A user default is unusable for this decision only when the normal current-user catalog eligibility predicate cannot return its referenced model under the post-commit state. A valid existing default is preserved, even when the newly configured provider would otherwise be recommended.

This ADR narrows ADR 0024's bootstrap semantics for Quick setup. A fixed profile slot is **untouched** only when its persisted state is still the original bootstrap state: `enabled = false`, no target model, version `1`, and no administrator updater. Being disabled by itself is not sufficient. Quick setup may fill and enable a slot only when the selected model's exact template key equals that slot's target in the existing `DEFAULT_RUN_PROFILE_CONFIGURATIONS` source data. Under policy v1 this means:

- OpenAI Terra may fill only `balanced`;
- OpenAI Luna may fill only `fast`;
- OpenAI Sol may fill only `deep`;
- OpenAI GPT-5.5, Anthropic Opus, and every OpenRouter candidate fill no profile; and
- no new Anthropic/OpenRouter recipe or reasoning tuple is inferred merely to make the UI appear complete.

Quick setup must preserve:

- every enabled profile;
- every profile with a target model;
- every profile whose version or updater shows an administrator edit; and
- every explicitly disabled profile that is no longer in the original untouched state.

Profile filling grants no additional access. A filled profile must resolve through the same direct entitlement and default-credential rules as any other run.

### Canonical personal recovery

GET state `needs_attention` represents a bounded recovery path, not a client-visible diagnosis. Recovery is eligible only when the server can prove that the persisted state is still one canonical, unambiguous personal graph: it has no same-family custom connection, group assignment, custom or extra model, draft check, extra/disabled/duplicate direct grant, or other team/Advanced state. It may contain at most one `Primary` credential and at most one supported selected Quick answer model.

Recovery preserves an existing supported selected model rather than reevaluating the current recommendation. When no selected model exists, the normal policy recommendation or no-write picker applies. After the same pre-transaction remote validation and fenced recheck as initial setup, one transaction repairs only the missing canonical connection/credential policy, `Primary` credential/version and pointer, selected answer deployment/version, exact active check, and exact acting-user grant needed to reach the personal Ready graph. The acting user's model default changes only when the prior default is null or unusable.

Recovery never fills a run profile, changes a usable default, creates a group mutation, adopts ambiguous state, or rewrites unrelated provider data. If the remote catalog no longer contains the already selected model, or any recheck reveals custom/team/ambiguous state, it commits nothing and directs the administrator to retry or use Advanced as appropriate.

### Safe API-key replacement

Quick setup may also replace the key for an existing unambiguous personal setup. The replacement targets the canonical connection's `Primary` default credential and creates a candidate credential version. The candidate is tested outside a transaction.

Until the candidate passes and the fenced commit succeeds, the existing active credential version, connection, models, checks, grants, user default, and profiles remain unchanged. An invalid key, provider outage, unsupported catalog, stale state, authorization change, or database failure therefore leaves the old active graph usable.

Replacement preserves the already selected Quick answer deployment. It never reevaluates the current recommendation to migrate a working setup and never offers a picker in place of that deployment. If the repeated catalog check does not contain the existing selected upstream model, replacement returns a safe no-write failure and the old graph remains Ready.

On success, a single transaction activates the candidate credential version and creates the new exact selected-model availability check. It retains the previous immutable credential version and does not rewrite connection activation metadata, the selected model/version, grant, user settings/default pointer, or profiles. Quick replacement performs no old-version cleanup; cleanup remains the separate ADR 0022 credential-version lifecycle and must preserve every live or recoverable accepted-run binding's exact historical version and snapshot. Replacement does not fill a previously untouched profile or otherwise replay initial-setup defaults.

### Quick-setup eligibility and the Advanced boundary

Quick setup may manage only a canonical code-owned connection whose state is simple and unambiguous. It must not flatten, infer, or overwrite an Advanced configuration.

The initial state may contain the canonical bootstrap connection plus absent code-owned model rows or code-owned model rows still in their exact untouched disabled seed state. Those rows are not Advanced configuration. Initial Quick setup may create the selected template row when absent or reuse it when untouched, and leaves every unselected untouched row disabled.

A recovery-eligible state is an already-configured but incomplete subset of the exact personal graph described above. It must remain losslessly attributable to at most one `Primary` credential, at most one Quick-supported selected answer model, and the acting administrator. Missing canonical pieces may be repaired; a draft check, group state, custom/extra model, ambiguous credential, or missing/disabled/duplicate grant on an otherwise selected graph is Advanced instead of recovery.

An existing setup is replacement-eligible only when the service can prove one canonical active/draft connection configuration, `use_default`, exactly one enabled `Primary` default credential with one non-revoked active version and no pending secret, exactly one active Quick-supported answer deployment, the one exact direct acting-user grant, matching checks, and no group assignment or pending/custom provider state. The selected deployment, not the current policy recommendation, identifies the replacement target.

The UI routes to Advanced when the provider has any material team or custom state, including:

- a custom endpoint or noncanonical connection configuration;
- another connection of the same provider family;
- credential policy `require_assignment`;
- multiple or ambiguous credentials instead of one `Primary` default credential;
- group credential assignments;
- custom model, routing, capability, or provider configuration;
- conflicting active or draft state that cannot be represented by the Quick setup plan; or
- any other state for which the service cannot prove that the bounded personal mutation is lossless.

Duplicate/disabled direct grants, an absent expected direct grant on an otherwise active personal graph, or an active model outside the policy's maintained Quick-supported template set are likewise ambiguous and require Advanced. Unrelated valid personal setups for other provider families do not make this provider Advanced.

The eligibility decision is server-authoritative on both `GET` and `POST`. Hiding Advanced controls in the client is not sufficient authorization or state protection. GET state `advanced_required` and the equivalent raced POST error `provider_quick_setup_advanced_required` do not mutate, test, normalize, or partially adopt the existing graph.

### Response and secret boundaries

Quick setup responses are deliberately narrow and flat. `GET` returns exactly `{ providers, suggestedProvider }`. It contains exactly one entry for each supported provider; an entry is `{ provider, providerDisplayName, state, stateToken, model? }`, where state is `not_configured`, `ready`, `needs_attention`, or `advanced_required`, `stateToken` is an opaque server fence, and `model` is present only for Ready and contains only `{ displayName }`. The fence HMAC uses a dedicated subkey derived from `AIQSA_AUTH_SESSION_SECRET` under the fixed `aiqsa:provider-quick-setup-state-token-key:v1` domain; `AIQSA_ENCRYPTION_KEY` remains dedicated to secret envelopes. `needs_attention` means only that the server proved the bounded recovery eligibility above; it remains a value-free generic classification, so the wire carries no reason, check time, raw provider/configuration detail, selected model, or remediation inference. `suggestedProvider` is one supported provider ID or null.

`POST` accepts exactly `{ expectedState, provider, secret, selectedModel? }`, where `expectedState` is the opaque GET/selection fence and the optional selection is exactly `{ candidateId, policyVersion }`. A successful response has only outcome `ready` or `selection_required`. Ready is exactly `{ checkedAt, defaultChanged, model, outcome, profilesFilled, provider, providerDisplayName }`; selection-required is exactly `{ candidates, checkedAt, expectedState, outcome, policyVersion, provider, providerDisplayName }`, and each model/candidate object contains only its approved display/opaque-choice fields. Eligibility races return `provider_quick_setup_advanced_required`; stale state, invalid selection, `provider_quick_setup_unsupported_catalog`, and other provider/persistence failures use a stable flat `{ error }` response. No success or error response adds internal IDs or nested lifecycle evidence.

They must not contain the API key, encrypted secret material, credential or credential-version identifiers, raw upstream bodies or headers, a full remote catalog, internal validation evidence, group membership data, or unrelated user data. Errors use the existing safe provider-error taxonomy and never echo upstream secret-bearing content.

The synchronous browser request has one truthful pending label, **Testing & saving…**, followed by `Ready`, `selection_required`, or a safe failure. `provider_quick_setup_advanced_required` handles a raced eligibility change, while `provider_quick_setup_unsupported_catalog` stays distinct and offers Advanced without claiming the saved graph itself requires Advanced. The client must not invent unobservable sequential phases such as “Activating model” or “Granting access.” A failed initial test/save retains the masked key only in the current browser form for retry; `selection_required` retains it only while choosing for that provider. Ready, provider change, opening Advanced, closing/unmounting the surface, or abandoning replacement clears it. Replacement always opens with an empty field and never echoes the saved key. A failed replacement keeps the prior Ready summary visible and unchanged.

Quick success invalidates the secret-free Control Center summary and the lazy Advanced provider/profile projections. Opening Advanced after success fetches canonical persisted state; Quick and Advanced never keep competing live owners for the same resource.

Dedicated accessibility implementation and conformance are outside this revamp slice. Responsive/mobile/touch behavior, safe-area and software-keyboard clearance, readable state/action copy, and overflow containment remain ordinary product behavior.

## Amendments to earlier decisions

This ADR makes the direct-user model-entitlement seam described in ADR 0022 the normal entitlement path for personal Quick setup. It does not add a direct-user credential-assignment seam: the personal credential remains the canonical connection default under `use_default`.

This ADR also amends ADR 0024 so that Quick setup may populate fixed run profiles only when they are provably untouched under the definition above. It does not change the all-slots atomic edit contract of the Advanced profile editor and does not let startup bootstrap overwrite administrator-owned mappings.

This is a behavioral and ownership decision. Policy v1 and the acting-user/connection structured-lock protocol express it through the established provider, access-grant, user-default, and run-profile contracts; task 391 therefore does not require a new uniqueness column or grant table. Any later implementation that cannot preserve those locks must document a schema change separately before shipping it.

## Required verification

The implementation must provide automated evidence for at least:

- administrator-only access and a server-authoritative Quick-versus-Advanced eligibility decision;
- bounded fake-transport catalog checks for OpenAI, Anthropic, and OpenRouter with no paid inference call;
- exact policy-v1 recommendation/picker tables for all three providers, invariant under remote ordering and duplicates, with Perplexity excluded from answer choices;
- `selection_required` producing no database writes and never returning or server-retaining the key, plus a second submission that repeats the remote check with the exact policy/candidate pair;
- all network I/O occurring before the commit transaction;
- transaction retry never repeating the provider request;
- stale/concurrent Quick-versus-Quick and Quick-versus-Advanced state rejecting the losing complete mutation without partial writes or duplicate direct grants;
- one atomic initial commit producing the canonical connection, `Primary` default credential/version, exactly one selected model version/check, one acting-user grant, conditional user default, and at most one exact untouched OpenAI profile mapping;
- one atomic bounded recovery commit preserving an existing supported selected model, repairing only the exact personal graph, conditionally changing only an unusable default, and never filling a profile;
- no group membership, group grant, or group credential-assignment mutation;
- a post-commit current-user filtered catalog containing the selected model before **Ready** is returned;
- preservation of a valid existing user default and of every administrator-touched profile;
- failed initial setup or recovery leaving no partial graph;
- failed key replacement preserving the complete previous active graph;
- replacement preserving the existing selected model, refusing missing-model migration without writes, and retaining the complete previous immutable credential version for the separate ADR 0022 lifecycle;
- secret redaction and the narrow response contract across success, provider failure, timeout, stale state, and persistence failure.

The repository evidence includes injected rollback failures after each initial/replacement write boundary, exact absence of group-table mutations, duplicate-grant prevention under concurrency, and a post-commit catalog predicate evaluated from the same transaction rather than a second global-Prisma snapshot. The fake transport evidence asserts the reviewed method, canonical URL/path and authentication headers for OpenAI, Anthropic, and OpenRouter; timeout, redirect, non-2xx, malformed body, row/byte bounds, permutation, duplicate, recommendation, picker, and empty-intersection cases; and zero paid-generation calls. Browser evidence mocks only the Quick endpoint, asserts that Advanced provider/profile resources are not requested before disclosure, and exercises fresh setup, picker resubmission, retryable failure, safe replacement, Ready-to-chat navigation, and compact/desktop layouts without a paid provider call or production fake-provider backdoor.

## Consequences

- A single administrator can make a supported provider usable with one provider choice, one key entry, and one **Test & Save** action; groups are not part of that path.
- Team and enterprise controls remain available without dominating the personal setup experience.
- Quick setup shares the same persisted control plane and run-admission rules as Advanced, so it does not create a weaker execution path.
- Recommendation policy becomes maintained product data and must be versioned whenever supported provider catalogs or model contracts change; an update affects new initial setup only and never silently migrates an existing replacement target.
- A successful catalog check proves current catalog visibility, not that every future generation request will succeed; normal run admission and provider failure handling still apply.
- Advanced configurations are preserved rather than automatically converted back into the personal shape.
