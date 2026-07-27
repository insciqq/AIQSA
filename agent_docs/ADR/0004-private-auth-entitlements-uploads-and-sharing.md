# ADR 0004: Private Auth, Entitlements, Uploads, And Sharing Are Early Foundations

Status: Accepted
Amends: none

## Context

The product now needs lightweight auth before provider work, user/group-specific provider and model access, a backend-served model/search catalog, PDF/image uploads, provider-specific search routing, OpenRouter route-provider selection, and anonymous secret-link chat sharing.

These requirements affect the schema, backend API contracts, frontend model selector, QSA request validation, attachment handling, and privacy model. Adding them after provider streaming would force a larger rewrite.

## Decision

Add the following capabilities as early foundations:

- simple private-MVP token auth before provider streaming;
- user/group entitlements for providers, models, and search strategies;
- backend-served current-user model/search catalog;
- PDF/image upload foundation with local S3-compatible storage and deterministic PDF text extraction;
- explicit search strategies, including OpenAI native `web_search` and OpenRouter/Perplexity where allowed;
- OpenRouter route-provider preferences for model routing;
- `Share (anonymously)` as an immutable sanitized snapshot, not live public chat access.

Keep this private/local first. Do not add public signup, billing enforcement, OAuth, provider-hosted vector stores, or public attachment sharing until separate tasks explicitly introduce them.

## Consequences

- The first fake-streaming MVP includes more backend foundation than originally planned.
- The frontend model selector must load available models/search strategies from the backend.
- Every model run must validate provider/model/search/attachment access on the backend.
- Uploaded files remain private by default.
- Public share links expose only sanitized snapshots and can be revoked.
- User/group entitlement concepts remain independent of the concrete authentication entry points.

## Addendum (2026-06-10, current state clarified 2026-07-23)

The "keep this private/local first" constraint is superseded. The shipped application now has multi-user password and optional Google/Yandex OAuth auth, verified admission/invites, revocable sessions, administrator workflows, hardened single-host deployment, and the original entitlement/upload/share foundations. Resource quotas, cost controls, and multi-replica coordination remain separate backlog work; current behavior is owned by `BACKEND.md`, `SECURITY.md`, and `ENV_VARIABLES.md` rather than this historical rollout boundary. ADR 0036 amends the sharing clause: publishing now requires an explicit confirmation and each chat's live links stay listed and revocable.
