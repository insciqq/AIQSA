# ADR 0026: Personal Provider Quick Setup

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0024-admin-managed-run-profiles

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

The exact URL and navigation label remain frontend routing decisions. This ADR fixes the product destinations and behavior, not a route string.

### Quick setup flow

For a provider that is eligible for Quick setup, the primary flow is:

1. Select the code-owned provider.
2. Enter an API key in a write-only field.
3. Select **Test & Save**.
4. Receive **Ready** only after the resulting model is present in the acting administrator's current-user filtered catalog.

Quick setup performs a bounded, read-only provider catalog request through the provider-specific adapter. It applies the existing outbound-request safety, timeout, redirect, response-size, and result-count limits. It must not perform a paid generation, embedding, image, audio, or other billable inference request. Any explicit generation diagnostic remains an Advanced action with its own confirmation.

The API key remains a write-only candidate throughout the flow. It is encrypted only as part of a successful commit and is never returned by an API, copied into a response, logged, included in an event, or interpolated into an error.

### Deterministic model selection

Each Quick-supported provider has a code-owned, versioned recommendation policy. The policy maps a bounded catalog result to a supported code-owned model configuration. Its ordered candidates and compatibility requirements are reviewable source-controlled data.

The recommendation must never be derived from the first remote row, remote ordering, alphabetical ordering, an untrusted popularity or pricing field, or a guess based on a model name. A newly appearing remote model cannot become the personal default until a code change explicitly adds it to the supported recommendation policy.

If no recommended candidate is present, Quick setup returns a compact `selection_required` result containing only the intersection of:

- models observed in the bounded catalog response; and
- code-owned model configurations that AIQSA can safely activate.

That result performs no durable write. The server does not retain the submitted key, catalog evidence, a draft credential, or a partial provider graph. The browser may retain the still-masked local form value while the administrator chooses a model. The subsequent **Test & Save** submission repeats the bounded remote check before it may commit. An empty intersection routes the administrator to Advanced with a safe explanation.

### Remote validation and atomic commit

All provider network I/O completes before the database transaction begins. After the remote result is available, Quick setup opens a short transaction, rechecks administrator authorization and the expected persisted state, and either commits the complete plan or commits nothing. A concurrent provider, credential, model, grant, user-default, or affected profile change makes the request stale; the service does not silently merge over it.

For initial setup, one fenced atomic commit establishes:

- the enabled canonical connection for the chosen code-owned provider;
- connection credential policy `use_default`;
- an enabled credential named `Primary`, its encrypted active credential version, and the connection's default-credential reference;
- the selected supported model deployment or deployments and their active versions;
- sanitized authoritative availability checks that match the tested candidate credential version and selected model versions;
- direct, model-specific entitlement grants for the acting administrator;
- the acting administrator's default model, but only when their prior default is null or unusable; and
- mappings for only those fixed run-profile slots that are still untouched and disabled.

The same transaction evaluates the current-user catalog eligibility predicate for the acting administrator. It may commit only if that projection contains the selected personal model. The endpoint returns **Ready** only from that proven persisted state.

Quick setup never creates, renames, adds members to, assigns credentials to, or grants models to a group. It grants no entitlement to another user.

Entitlement and credential resolution remain separate:

- the direct user grant authorizes the acting administrator to use a specific model deployment;
- `use_default` resolves that deployment to the connection's default active credential; and
- neither fact implies the other or authorizes any other provider model.

Quick setup does not introduce or authorize direct-user credential assignment. Team-specific credential selection continues to use the assignment rules from ADR 0022 in Advanced.

### Existing defaults and profiles

A user default is unusable for this decision only when the normal current-user catalog eligibility predicate cannot return its referenced model under the post-commit state. A valid existing default is preserved, even when the newly configured provider would otherwise be recommended.

This ADR narrows ADR 0024's bootstrap semantics for Quick setup. A fixed profile slot is **untouched** only when its persisted state is still the original bootstrap state: disabled, no target model, initial version, and no administrator updater. Quick setup may fill and enable only those slots for which its code-owned profile recipe has a compatible selected model. It must preserve:

- every enabled profile;
- every profile with a target model;
- every profile whose version or updater shows an administrator edit; and
- every explicitly disabled profile that is no longer in the original untouched state.

Profile filling grants no additional access. A filled profile must resolve through the same direct entitlement and default-credential rules as any other run.

### Safe API-key replacement

Quick setup may also replace the key for an existing unambiguous personal setup. The replacement targets the canonical connection's `Primary` default credential and creates a candidate credential version. The candidate is tested outside a transaction.

Until the candidate passes and the fenced commit succeeds, the existing active credential version, connection, models, checks, grants, user default, and profiles remain unchanged. An invalid key, provider outage, unsupported catalog, stale state, authorization change, or database failure therefore leaves the old active graph usable.

On success, a single transaction activates the candidate credential version, retains the previous immutable version according to ADR 0022's accepted-run retention rules, refreshes only the checks proven by the new catalog result, and preserves unrelated grants, defaults, models, and profiles. Accepted runs continue to bind to their exact historical versions.

### Quick-setup eligibility and the Advanced boundary

Quick setup may manage only a canonical code-owned connection whose state is simple and unambiguous. It must not flatten, infer, or overwrite an Advanced configuration.

The UI routes to Advanced when the provider has any material team or custom state, including:

- a custom endpoint or noncanonical connection configuration;
- credential policy `require_assignment`;
- multiple or ambiguous credentials instead of one `Primary` default credential;
- group credential assignments;
- custom model, routing, capability, or provider configuration;
- conflicting active or draft state that cannot be represented by the Quick setup plan; or
- any other state for which the service cannot prove that the bounded personal mutation is lossless.

The eligibility decision is server-authoritative. Hiding Advanced controls in the client is not sufficient authorization or state protection.

### Response and secret boundaries

Quick setup responses are deliberately narrow. They may contain the outcome (`ready`, `selection_required`, `stale`, or a safe failure), the provider and selected model display data needed by the UI, whether the personal default changed, which untouched profile slots were filled, and the sanitized check time.

They must not contain the API key, encrypted secret material, credential or credential-version identifiers, raw upstream bodies or headers, a full remote catalog, internal validation evidence, group membership data, or unrelated user data. Errors use the existing safe provider-error taxonomy and never echo upstream secret-bearing content.

## Amendments to earlier decisions

This ADR makes the direct-user model-entitlement seam described in ADR 0022 the normal entitlement path for personal Quick setup. It does not add a direct-user credential-assignment seam: the personal credential remains the canonical connection default under `use_default`.

This ADR also amends ADR 0024 so that Quick setup may populate fixed run profiles only when they are provably untouched under the definition above. It does not change the all-slots atomic edit contract of the Advanced profile editor and does not let startup bootstrap overwrite administrator-owned mappings.

This is a behavioral and ownership decision. It does not, by itself, assert a new database schema requirement. Any implementation that cannot express the decision through the established provider, access-grant, user-default, and run-profile contracts must document its schema change separately before shipping it.

## Required verification

The implementation must provide automated evidence for at least:

- administrator-only access and a server-authoritative Quick-versus-Advanced eligibility decision;
- bounded fake-transport catalog checks for OpenAI, Anthropic, and OpenRouter with no paid inference call;
- deterministic, versioned recommendation independent of remote ordering;
- `selection_required` producing no database writes and never returning or retaining the key;
- all network I/O occurring before the commit transaction;
- stale/concurrent state rejecting the complete mutation without partial writes;
- one atomic initial commit producing the canonical connection, `Primary` default credential/version, selected model versions/checks, acting-user grants, conditional user default, and only untouched profile mappings;
- no group membership, group grant, or group credential-assignment mutation;
- a post-commit current-user filtered catalog containing the selected model before **Ready** is returned;
- preservation of a valid existing user default and of every administrator-touched profile;
- failed initial setup leaving no partial graph;
- failed key replacement preserving the complete previous active graph;
- successful replacement retaining historical versions needed by accepted runs; and
- secret redaction and the narrow response contract across success, provider failure, timeout, stale state, and persistence failure.

## Consequences

- A single administrator can make a supported provider usable with one provider choice, one key entry, and one **Test & Save** action; groups are not part of that path.
- Team and enterprise controls remain available without dominating the personal setup experience.
- Quick setup shares the same persisted control plane and run-admission rules as Advanced, so it does not create a weaker execution path.
- Recommendation policy becomes maintained product data and must be versioned whenever supported provider catalogs or model contracts change.
- A successful catalog check proves current catalog visibility, not that every future generation request will succeed; normal run admission and provider failure handling still apply.
- Advanced configurations are preserved rather than automatically converted back into the personal shape.
