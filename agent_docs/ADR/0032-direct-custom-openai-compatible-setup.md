# ADR 0032: Direct Custom OpenAI-Compatible Setup

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0026-personal-provider-quick-setup, 0028-task-first-control-center-and-direct-provider-setup

Amendment note: ADR 0033 keeps this atomic Custom setup contract but presents Custom as a Setup subtask and hands its exact created connection to the peer Connections task instead of a separate Advanced page. ADR 0039 makes Custom the fifth Quick-setup choice, replaces manual-only discovery and fixed Chat with discovery-first explicit Chat/Responses selection, permits an ordered bounded set of discovered models behind per-model tests and one atomic commit, adds the same id-only discovery picker to saved Custom connections, and adds reviewed hosted-tool declarations plus fenced whole-graph deletion.

## Context

The reviewed OpenAI, Anthropic, Gemini, and OpenRouter Quick path is intentionally code-owned and cannot import arbitrary upstream model rows. Administrators nevertheless need a direct way to try a self-hosted gateway, local inference server, or another OpenAI-compatible endpoint without pretending it is one of those providers and without walking through connection draft, credential, model, activation, assignment, group, and entitlement screens.

A compatibility label alone is not enough to infer protocol, authentication, network trust, capabilities, or model identity. The simple path therefore needs a narrow explicit contract that preserves the existing provider-control-plane lineage and fail-closed endpoint policy.

## Decision

`Control Center -> Providers` exposes **Connect custom endpoint** as a separate task beside, not inside, the four reviewed-provider choices. Its default sequence is API root -> manual model ID -> write-only API key -> **Test & Save**. The task fixes the protocol to generic OpenAI-compatible Chat Completions and shows the derived `/chat/completions` target; compatible Responses, arbitrary headers, routing, additional models/credentials, pricing, and other expert controls remain Advanced work.

`POST /api/admin/providers/custom-setup` is active-administrator-only and accepts a bounded server-owned configuration. It validates the canonical root, manual model id, capability/default bounds, paid-test confirmation, private-network opt-in, and explicit `bearer | none` authentication before outbound I/O. Public endpoints require HTTPS and a non-empty bearer key. `none` is permitted only for an explicitly allowed local/private HTTP root; an absent legacy authentication mode always means bearer and never silently becomes keyless.

The service sends one exact tiny-generation test outside the database transaction. Failure writes nothing and returns only a stable value-free error. Success enters one retry-bounded serializable transaction that revalidates the active administrator/session and atomically creates an already-active `openai_compatible` connection, one Chat deployment, one immutable tested credential version, its exact availability check, the acting administrator's direct credential assignment, a direct model entitlement, and a conditional user default. It creates no group and does not replace an already usable default.

Bearer secrets use the existing purpose-bound encrypted envelope. Explicit no-auth uses a real null envelope, never an empty/sentinel key; both the immutable version evidence and connection configuration record `authenticationMode: none`. The database accepts a null active version only with that explicit tested evidence. Runtime resolution separately requires the explicit connection mode, a null envelope, a live non-revoked version, and the same per-request row lock/revocation guard used by bearer credentials. The generic transport omits `Authorization` only in that exact mode.

The created connection remains a normal provider-control-plane resource. Entitlement and credential selection are still separate rows, `Full access` remains semantic entitlement rather than a key selector, internal ids and secrets never enter the normal receipt, and Advanced can manage later lifecycle changes. Arbitrary remote catalogs and provider-specific hosted tools are not inferred from the manual model name.

## Consequences

- A single administrator can connect and use a compatible model without creating or assigning a group.
- The frequent setup task stays short while enterprise lifecycle controls remain available without being mixed into it.
- Keyless local inference is explicit and testable without weakening legacy bearer behavior or using fake secrets.
- The shared compatible Chat adapter remains reusable; this decision does not reintroduce Gemini compatibility code or create another transport.
