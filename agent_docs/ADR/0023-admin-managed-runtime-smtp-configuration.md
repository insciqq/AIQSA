# ADR 0023: Administrators Manage Runtime SMTP Configuration

Status: Accepted
Amends: 0008-multi-user-auth-direction, 0020-unified-installation-and-isolated-development

## Context

AIQSA uses SMTP for access-request verification, password reset, and optional administrator-invitation delivery. The first administrator is created active and verified, manual invite links remain usable, and emergency login is an explicit recovery path. SMTP is therefore an optional installation integration rather than a bootstrap, login, or core-readiness dependency.

The current mailer reads `AIQSA_SMTP_*` once when its module loads and exposes a separate synchronous `deliveryConfigured` flag. That cannot support safe live configuration: a change requires restart, and availability checked before `send()` may become stale before the attempt.

SMTP is simpler than an LLM or MCP runtime. There is one installation-wide channel, no user/group credential selection, no durable mail queue, no provider-native recovery handle, and no need to resume a historical send after restart. It needs exact-draft testing and safe per-send snapshots, but not immutable revision history, secret-use leases, or a drain reconciler.

## Decision

### Ownership and scope

- Postgres owns one permanent installation SMTP control row. A fixed singleton identity plus a database constraint, not a count-before-create check, prevents a second row; clearing configuration never deletes or recreates the control row.
- Only an active administrator may configure, edit, test, activate, enable/disable, or confirmation-clear it through a separate `/api/admin/email` route family and `Admin -> Email delivery` surface.
- `AIQSA_APP_BASE_URL` remains environment-owned because it is the trusted origin for links, callbacks, origin checks, and security headers. `AIQSA_ENCRYPTION_KEY` remains the application-secret root established by ADR 0022.
- Connection, command, complete-send, response-size, line/count, concurrency, and other hard safety limits remain code-owned or technical environment settings. Administrators cannot raise them beyond reviewed caps.
- After the offline cutover, SMTP host, port, From, username, password, authentication, transport mode, and internal-network policy are database-only normal-runtime settings.

### One-row draft and active lifecycle

The singleton contains two independent slots and monotonic counters rather than revision tables:

- mutable `draft`: normalized bounded configuration, an encrypted password envelope plus its `draftSecretGeneration`, monotonically increasing `draftVersion`, and optional `testedDraftVersion` plus sanitized test evidence;
- `active`: one complete configuration, matching encrypted password envelope plus its `activeSecretGeneration`, `activeVersion`, enabled state, and safe activation metadata.

There are no SMTP revision or password-history tables.

- Save requires the caller's `expectedDraftVersion`, validates and normalizes the complete candidate, applies an explicit password action (`preserve`, non-empty `replace`, or confirmation-gated `clear`), increments `draftVersion`, and clears prior test evidence. Replace allocates the next secret generation, preserve retains it, and clear removes the envelope without resetting the counter. Empty string has no ambiguous preserve/clear meaning; a version mismatch returns conflict.
- Testing loads one exact `(draftVersion, draft configuration, draftSecretGeneration, encrypted password)` snapshot, performs the bounded network transaction outside a long database transaction, and compare-and-set stores its sanitized result only when `draftVersion` is unchanged; only success sets `testedDraftVersion`.
- Activation requires the caller's expected draft/active versions and `testedDraftVersion == draftVersion`, then atomically copies the complete tested configuration, exact encrypted password, and `draftSecretGeneration` into the active slot as `activeSecretGeneration`, increments `activeVersion`, and enables it. The same purpose/owner/generation AAD permits copying the exact tested envelope; activation must never combine a new configuration with an older password. Failed/stale testing or activation leaves the previous active slot unchanged.
- Re-enabling an unchanged complete active slot is allowed with `expectedActiveVersion` and increments `activeVersion`. Any material draft or secret edit still requires Test and Activate.
- Disable requires `expectedActiveVersion`, atomically disables and increments `activeVersion`, and prevents sends that load configuration afterward. A send that already loaded its immutable in-memory snapshot may finish under its existing deadline.
- Delete is a confirmation-gated atomic clear that requires expected draft/active versions, disables and clears both slots, test evidence, and current health, and increments both versions. The permanent row and its monotonic secret-generation counter remain, so a late Test cannot settle after Delete and no clear/recreate ABA is possible. Delete does not wait for, recall, or mutate an already loaded send. There is no archive/restore or rollback to an historical password.
- Superseded ciphertext stops being database-reachable for new operations when the row update commits. A bounded Test or Send that already loaded it may retain ciphertext/plaintext in memory until completion. Physical remnants in PostgreSQL MVCC/WAL or backups follow database and backup retention; AIQSA does not promise forensic erasure at a precise instant.

`draftVersion` is the sole stale-test fence. Draft/active versions and the secret-generation counter never reset. A secret generation identifies one encrypted value independently of which singleton slot currently references it; it is not a reusable secret-history resource.

### Secret contract

- SMTP passwords use ADR 0022 envelope v2: AES-256-GCM with a fresh nonce and authenticated context containing purpose `smtp_password`, the fixed singleton owner, and `secretGeneration`.
- Passwords are strictly write-only. Browser reads expose only `passwordConfigured` and safe version/test/activation timestamps; plaintext and ciphertext never enter client payloads, test evidence, health data, public output, or logs.
- Username/password authentication can be activated only as a complete pair. Authentication mode `none` requires both username and password to be explicitly clear, so a hidden reusable secret cannot remain behind an unauthenticated active configuration.
- An unreadable active envelope yields sanitized `secret_unreadable` mail degradation. It never blocks initial-admin access, password login, manual invite-link copy, or emergency recovery.
- Database backups contain ciphertext but not `AIQSA_ENCRYPTION_KEY`; the operator backs up that root separately.

### Transport and destination security

Transport is one discriminated mode:

- `implicit_tls` establishes TLS before SMTP commands;
- `starttls_required` requires advertised STARTTLS, a successful verified upgrade, and a new EHLO before authentication;
- `plaintext_internal_no_auth` is an explicit reviewed exception for an internal relay with no username or password.

The transport boundary preserves these guarantees:

- STARTTLS never downgrades. Username/password AUTH is sent only over verified TLS, and mechanisms remain a code-owned allowlist.
- Certificate and hostname verification remain enabled; no routine setting disables them.
- Plaintext requires explicit internal-network approval and carries no authentication material.
- Host is a normalized hostname or IP literal rather than a URL. Host, port, username, password, From, recipient, mailbox/header values, and protocol fields are validated and bounded; CR/LF header injection is rejected.
- Public destination policy rejects loopback, private, link-local, metadata, multicast, unspecified, reserved, and other special-use addresses. Explicit internal approval may admit a reviewed private/loopback relay but never metadata, link-local, multicast, or unspecified destinations.
- The protocol-specific connector uses the shared server egress address-classification rules: DNS is resolved and checked immediately before connect, the socket is pinned to an approved result, and TLS SNI/certificate validation remains bound to the configured hostname.
- SMTP banners and multiline replies are untrusted input. Line length/count, cumulative bytes, commands, idle time, and absolute transaction time are bounded; overflow destroys the socket and returns a stable sanitized code.
- AIQSA sends only product-owned verification, reset, invitation, and configuration-test templates. The admin API is not an arbitrary message or relay endpoint.

### Test and activation experience

- `Test draft` performs one complete SMTP transaction against the exact draft: connect, greeting/EHLO, required TLS, authentication where configured, envelope sender/recipient, DATA, and terminal server acceptance.
- The acting administrator provides a one-use test recipient because the bootstrap address may deliberately be local. It is validated and rate/concurrency limited, used only for that request, and not persisted in configuration, health, or logs.
- The test message identifies itself as an AIQSA configuration test and contains no access, invite, reset, session, OAuth, or other bearer link.
- The UI states that testing sends a message and may distinguish derived states such as `Not configured`, `Draft changed`, `Needs test`, `Tested`, `Active`, `Disabled`, and `Degraded`. These are presentation states, not another persisted workflow enum.

### Runtime dispatch and concurrency

- One asynchronous mail-dispatch boundary replaces the process-start SMTP snapshot and separate `deliveryConfigured` pre-check.
- Each send performs one consistent database read of enabled state plus the complete active configuration and matching encrypted password, decrypts it, and owns that immutable in-memory snapshot for the bounded SMTP transaction.
- The next send observes activation, Disable, or Delete without restart, caching, or connection-pool invalidation. The initial implementation opens one connection per message and does not pool across active versions.
- A small process-local semaphore bounds simultaneous sockets. Saturation produces stable internal `overloaded` failure under the existing caller-specific outcome, without a queue, jobs table, or distributed coordinator.
- Deterministic test mode has absolute precedence over database SMTP and always uses the local memory/test mailer. Routine Vitest and Playwright cannot contact a real relay.

Internal dispatch distinguishes `accepted`, `unavailable`, stable sanitized failure, and `ambiguous_after_data`. `Unavailable` means only that no enabled complete active slot exists; an unreadable secret, invalid active state, overload, transport error, or ambiguity is an active-configuration/send failure.

### Acceptance and existing auth behavior

- A message is accepted only after a successful `250` reply following DATA. A later QUIT timeout or rejection does not reverse that acceptance.
- Disconnect, timeout, or unreadable response after DATA was transmitted but before the terminal reply is ambiguous. AIQSA does not retry automatically because the relay may already have accepted the message.
- `sent` means accepted by the configured SMTP server, not delivered to an inbox. There is no durable outbox, retry worker, bounce processing, delivery-status processing, or exactly-once claim.
- A transient failure or ambiguity records sanitized degradation but never automatically changes or disables the active configuration. Send outcomes update health only by compare-and-set against the `activeVersion` loaded for that send; a late outcome from a superseded version cannot alter current health.

ADR 0008 auth outcomes remain unchanged:

- registration maps absent/disabled SMTP to `verification_email_unavailable` and an active-configuration/send failure to `verification_email_failed`; its already persisted token is not rolled back solely for mail failure;
- password-reset request keeps its generic SMTP-independent response floor, persists an eligible token before bounded asynchronous delivery, and does not await SMTP in the public response;
- invitation creation commits before optional mail, preserves `not_requested | unavailable | failed | sent`, and always returns the one-time URL for manual copy;
- missing or broken SMTP never blocks initial-admin login, existing-user login, manual link distribution, or explicitly enabled emergency recovery.

### Minimal health, privacy, and administration metadata

The singleton may retain only safe fields such as `lastAttemptAt`, `lastAcceptedAt`, `lastFailureAt`, `lastFailureCode`, `updatedAt/updatedBy`, and `activatedAt/activatedBy`, scoped to an `activeVersion`. Activation or Enable resets prior-version health; `Degraded` means an unreadable current secret or the latest current-version attempt failed and has not been superseded by a later acceptance.

Logs and persisted health contain no recipient, subject/body, bearer URL, raw SMTP banner/reply, resolved internal address, username, password, AUTH payload, or ciphertext. Password-reset mail logging remains non-request-correlatable and cannot reveal account eligibility.

This decision introduces no SMTP-specific append-only audit/event or request-idempotency ledger. Configuration mutations use optimistic version checks and ordinary atomic database mutation; a future general administrator audit facility may cover them.

### Readiness and bootstrap

- SMTP remains optional. Missing, disabled, degraded, or unreadable SMTP does not fail `/api/health/ready`.
- Fresh-install bootstrap creates the verified initial administrator without sending mail and requires no SMTP fields.
- Login and Admin remain reachable before SMTP configuration. Access-request and reset surfaces preserve their truthful/generic behavior.
- The installation encryption key remains a shared encrypted-state readiness requirement; an SMTP-specific remote outage is not a core dependency failure.

### Offline full cutover

- SMTP uses the stopped-application maintenance cutover from ADR 0022. A coordinated backup is taken first and the maintenance boundary holds the installation advisory lock. The migration-only tools service receives legacy SMTP values plus `AIQSA_ENCRYPTION_KEY`; the application runtime keeps the encryption key but receives no legacy SMTP values. There is no compatibility window, dual read/write, fallback to environment SMTP, migration-acknowledgement setting, or old/new runtime overlap.
- A complete legacy SMTP configuration is structurally validated and imported as one disabled, untested v2-encrypted draft. Host and From are required; username/password are either both present or both absent. Technical timeout/default fields alone mean unconfigured, while partial credentials or invalid host/mailbox values abort with value-free field-class errors.
- `AIQSA_SMTP_SECURE=1` maps to `implicit_tls`; otherwise `AIQSA_SMTP_STARTTLS=1` maps to `starttls_required`. With both disabled, only a credential-free `plaintext_internal_no_auth` draft may be imported and it still requires explicit internal-network review before testing/activation.
- Import performs no DNS lookup, network connection, authentication, or test message and never activates SMTP. Destination review, Test, and Activate occur in Admin after startup.
- The release removes SMTP host, port, From, username, password, auth, and transport variables from runtime Compose, `.env.example`, and installation documentation. Technical mail time/size/concurrency bounds remain environment- or code-owned. The new runtime never falls back to legacy values.
- If legacy SMTP is absent, the singleton remains empty. Failure is recovered only by restoring the pre-cutover backup, correcting the source, and rerunning; mixed environment/database authority is unsupported.

This amends ADR 0008 only in SMTP configuration ownership and mail-dispatch resolution. It amends ADR 0020 without adding a worker, queue, or deployment service. It uses ADR 0022 envelope v2 but deliberately does not inherit provider credential versions, recovery horizons, force-revocation claims, or drain machinery.

### Required implementation evidence

Implementation is not complete without deterministic evidence for:

- active-admin authorization, ordinary-user denial, and database-enforced singleton identity;
- optimistic Save/Activate/Enable/Delete conflicts, monotonic clear without ABA, draft-version invalidation, stale-test CAS rejection, failed-test preservation of the old active slot, and atomic activation of matching configuration/password/generation;
- write-only envelope-v2 storage plus preserve/replace/clear and username/password-pair semantics;
- implicit TLS, STARTTLS without downgrade, plaintext without credentials, certificate verification, address pinning, input/header validation, and bounded SMTP replies;
- complete safe test-message behavior with an ephemeral recipient and no bearer links;
- DATA acceptance, QUIT-after-acceptance, ambiguous post-DATA outcomes, and absence of automatic retry;
- consistent per-send snapshots, dynamic next-send activation/disable/delete, superseded-version health fencing, in-flight behavior, semaphore bounds, and deterministic test-mail precedence;
- unchanged registration, reset, invitation, initial-admin, manual-link, and recovery outcomes;
- stopped full cutover, disabled untested import, runtime env removal, and absence of fallback.

## Consequences

- Administrators can configure and rotate email delivery after login without deployment edits or restart, while the prior tested active configuration keeps working until atomic activation.
- One draft/active singleton preserves stale-test safety and per-send consistency without SMTP revision history, secret-version retention, leases, a drain protocol, or a mail-specific audit subsystem.
- Strict TLS, destination policy, parser limits, and unambiguous DATA acceptance protect credentials and one-time links without adding a durable delivery system.
- SMTP remains optional and cannot lock an operator out of a fresh or existing installation.
