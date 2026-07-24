# ADR 0024: Administrators Map Three Stable Run Profiles To Deployments

Status: Accepted
Amends: 0016-responsive-composer-disclosure, 0022-admin-managed-llm-provider-control-plane

## Context

Fast, Balanced, and Deep were browser-owned shortcuts identified by provider family and upstream model strings. ADR 0022 replaced those strings as runtime identities with opaque `ProviderConnection.id` and `ProviderModel.id`. The shortcuts therefore stopped resolving even though the Luna, Terra, and Sol deployments still existed. Keeping another frontend identity table would repeat that coupling and could not represent administrator-created deployments safely.

The three names remain useful product-level intents and have established compact-composer placement under ADR 0016. Administrators need to choose what each intent means for their installation without turning the composer into an arbitrary recipe system or allowing a shortcut to silently change unrelated generation controls.

## Decision

1. AIQSA has exactly three code-owned semantic run-profile slots: `fast`, `balanced`, and `deep`. Their labels and order are fixed. Administrators may edit each short user-facing description, map it to one concrete `ProviderModel.id`, choose a supported reasoning mode and effort, or disable it by clearing the target. Arbitrary profile counts, renamed slots, and user-owned recipes are outside this decision.
2. Postgres owns the current mapping in `RunProfile`. Each row stores the stable slot ID, description, nullable deployment target, enabled state, reasoning tuple, optimistic version, and last administrator identity/time. A foreign key restricts deletion of a referenced model until the profile is disabled or reassigned.
3. `GET` and `PUT /api/admin/run-profiles` are active-administrator-only. The browser receives safe deployment display/capability metadata, never provider credentials or active configuration. A write must contain each fixed slot exactly once and compare all three expected versions under one locked transaction. Every enabled target must still be an active selectable deployment supporting the requested reasoning tuple; stale or invalid input changes no row.
4. Upgrade migration adopts the historical mappings by code-owned template identity when those deployments exist: Fast -> Luna / Standard / Medium, Balanced -> Terra / Standard / Medium, and Deep -> Sol / Pro / Maximum. A missing deployment produces a disabled row. Installation bootstrap creates only missing disabled slots and never overwrites administrator-owned mappings; deterministic development seed restores the three default fixtures.
5. The authenticated current-user catalog is the only composer projection. It emits enabled profiles in fixed order. If the configured target is in that user's entitled and currently available concrete model catalog, the projection contains the same opaque connection/deployment IDs and reasoning tuple. Otherwise it contains only a generic unavailable reason and no target identity. An administratively disabled slot is omitted.
6. The browser never matches a profile by provider family, template key, display name, or upstream model ID. It resolves and applies only the server-projected opaque model tuple. Active Profile versus `Custom` remains derived from effective connection, deployment, reasoning mode, and reasoning effort; profile identity is not persisted in user settings or accepted runs.
7. Applying a profile changes only its concrete model and reasoning tuple. Search, prompt, temperature, output limit, Background, Stream, and display preferences remain the selected target model's independent draft controls. Existing accepted runs and immutable provider bindings are unchanged by later profile edits.
8. The compact administrator editor belongs at `Admin -> Providers` because it maps semantic shortcuts onto provider deployments. `Model access` continues to own entitlements; assigning a profile grants no model access and reveals no otherwise hidden deployment.

## Consequences

- Provider-control-plane identity changes no longer require a composer release or a second frontend model registry.
- The three familiar one-tap intents remain visually and semantically stable while installations can use different active deployments.
- A profile may be visible but disabled for one user when its administrator-selected deployment is unavailable to that user; the reason remains generic so catalog filtering does not leak provider metadata.
- Administrators update the profile set atomically and must resolve stale versions or inactive/unsupported targets explicitly.
- Future arbitrary recipes or per-user profile customization require a new decision rather than extending these system slots implicitly.
