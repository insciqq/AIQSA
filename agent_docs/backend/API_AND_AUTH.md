# BACKEND API AND AUTH

Owner: Server API contract maintainers
Scope: Non-normative router to bounded backend API and observable state-transition owners.

This file is a routing index, not an API contract owner. Read only the leaf that owns the affected route family or transition.

| Read when | Contract owner |
| --- | --- |
| Backend goals, route ownership, shared private-route boundaries, API conventions, or change rules | [Foundations](api/FOUNDATIONS.md) |
| Passwords, sessions, recovery, auth admission, OAuth, registration, invites, verification, or onboarding | [Auth and onboarding](api/AUTH_AND_ONBOARDING.md) |
| Administrator team/access, releases, providers, Search, MCP, or control-plane mutations | [Admin control plane](api/ADMIN_CONTROL_PLANE.md) |
| Current-user catalogs/settings, chats, Assistants, messages, branches, runs, tools, inspection, or cancellation | [Catalog, chats, and runs](api/CATALOG_CHATS_AND_RUNS.md) |
| Uploads, attachments, processing/settlement, anonymous shares, reads, expiry, or revocation | [Uploads and shares](api/UPLOADS_AND_SHARES.md) |

Threat controls are routed through [security](../SECURITY.md), durable data rules through [persistence and retention](PERSISTENCE_AND_RETENTION.md), provider behavior through [provider adapters](PROVIDER_ADAPTERS.md), and product-level run meaning through [the run pipeline](../RUN_PIPELINE.md).
