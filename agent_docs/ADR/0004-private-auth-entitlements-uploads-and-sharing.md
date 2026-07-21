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
- Auth can later be replaced by Auth.js or Clerk without removing user/group entitlement concepts.

## Addendum (2026-06-10)

Direction changed: a self-hosted multi-user deployment (50+ users) is now planned, so the "keep this private/local first" constraint is superseded. The foundations in this ADR stand; the explicit follow-up tasks this ADR required (real auth, quotas/billing controls, hardening) now exist in `agent_docs/backlog/`.
