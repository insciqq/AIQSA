# BACKEND API — FOUNDATIONS

Owner: Server API contract maintainers
Scope: Backend goals, route-family ownership, shared private-route boundaries, and API change rules.
Read when: Changing route ownership, cross-cutting API conventions, private-route guards, state-transition style, or API contract maintenance rules.
Code owners: `app/api/`, shared server handlers, request-auth/origin middleware, and generated API-reference owners.
Not owned here: Specific auth, admin, chat/run, upload/share, or provider wire behavior.

## Backend Goals

The backend supports a transparent, provider-neutral AI workspace without becoming an unrestricted workflow platform. It owns:

- password and optional Google/Yandex OAuth authentication, access requests, direct invites, verification, reset, revocable sessions, and administrator recovery;
- user/group entitlements and administrator control planes for providers, Search, SMTP, and MCP;
- backend-filtered catalogs and saved user defaults;
- persistent folders, chats, message branches, Assistants, runs, attachments, shares, usage, and inspection evidence;
- deterministic fake-provider execution plus OpenAI, Anthropic, Gemini, OpenRouter, and compatible-provider adapters;
- private upload processing and anonymous sanitized share snapshots;
- passive administrator-only awareness of stable public GitHub releases.

## API Ownership

The executable route inventory and methods live in `app/api/**/route.ts`; shared wire contracts and route tests own exact request and response shape. Do not maintain a second endpoint manifest in prose.

Stable route families are:

- health plus password/OAuth/onboarding/recovery authentication;
- current-user identity, catalog, settings, explicit Memory management, and MCP
  configuration;
- administrator users, groups, grants, rules, invites, providers, Search, SMTP, MCP, release awareness, and usage;
- current-user Assistants: list/detail, create/revise/archive, duplication, revisions, exact-revision publications, and per-user pins;
- current-user Knowledge Bases: entitled embedding destinations, list/detail, create/update/archive, live group/installation publication management, owner-only document upload/replace/archive/retry with progress, and shadow-generation reindex;
- folders, chats, messages, model runs, and uploads;
- private share management plus anonymous public-share reads.

There are no standalone current-user provider, model, or usage control planes. User projections remain entitlement-filtered and separate from administrator configuration. Public operational health returns only `ok`, `ready`, or `not_ready` and exposes no dependency error or configuration value; [Architecture](../../ARCHITECTURE.md) owns the readiness dependency boundary.

All private routes resolve an active current user through the shared request-auth boundary. Browser mutations also pass the central same-origin guard. [HTTP and auth security](../../security/HTTP_AND_AUTH.md) owns cookie/session lookup, password hashing, admission limits, proxy trust, Origin rules, recovery exposure, and threat controls. This document records observable state transitions.

## Change Rules

- Preserve the shared auth/origin guards and least-data projections.
- Keep exact wire shape in `lib/contracts/**`, exact route inventory in source/generated reference, and exact transaction behavior in repositories/tests.
- Keep route files thin and extend the current domain handler/repository before
  adding another API boundary; a new public route family requires an explicit
  contract owner.
- Update this document only for durable route-family behavior or ownership. Implementation filenames and exhaustive endpoint details belong in source, generated inventories, and focused tests.
