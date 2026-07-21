# ADR 0013: Browser Verification Is Invocation-Isolated

Status: Superseded
Amends: 0003-autonomous-agent-delivery, 0012-crash-recoverable-verification-resources

Superseded by: 0015-lean-local-development-harness

## Context

Routine Playwright and deterministic gallery runs previously shared a fixed gallery schema, the developer upload bucket, one app port, and common artifact/evidence roots. A direct Playwright command could also reuse an existing development server. Prefix-shaped environment values were sufficient to enable deterministic auth, so a stale or misdirected command could reach session, mail-sink, or cleanup behavior without proving ownership of the live database and object namespace. Separate repository worktrees also targeted one fixed Compose project and its published host ports.

## Decision

Every routine browser or gallery invocation uses the crash-recoverable owner from ADR 0012. It receives a generated PostgreSQL schema, its exactly mapped MinIO bucket, an owned one-off app container, and the SHA-256 digest of the canonical ownership marker as a non-secret invocation identifier. The raw recovery token and marker never enter the app container, and the bind-mounted private `.aiqsa` directory is shadowed there.

Static Playwright configuration rejects missing test auth, `public`, `ui_shots`, protected or mismatched buckets, missing/malformed marker digests, alternate base URLs, and server reuse. Before migration or seed, again before specs, and immediately before deterministic session, auth-mail, global session-revocation, or direct cleanup behavior, the runtime reads the current PostgreSQL schema comment and bounded private MinIO marker. Both bytes must be identical canonical marker JSON and their digest, schema, and bucket must match the invocation environment. Failure is closed and performs no protected mutation. Explicit operator-driven final UX evidence remains separate: it uses an existing server, never test auth, is restricted to its one exact evidence spec, and does not participate in routine namespace ownership.

Routine Playwright artifacts and full/affected gallery evidence are written below machine-owned roots under the invocation identifier. Playwright clears only its own artifact directory; gallery cleanup removes only its own fixture graph after a fresh live proof; output cleanup accepts the current exact identifier rather than a caller path. Evidence from sibling invocations remains preserved and is never merged implicitly.

Verification infrastructure uses a deterministic Compose project derived from the canonical checkout path plus a static verification override that publishes no host ports. Service, volume, one-off-container, working-directory, and ordered Compose-file labels remain exact ownership evidence. One stateful suite retains one worker, while independent suites and worktrees may overlap because schemas, buckets, app network namespaces, and output roots are disjoint.

## Consequences

- The fixed `ui_shots` schema is denylisted legacy state, not an executable gallery path.
- Direct routine Playwright commands fail during configuration; supported browser and gallery commands start at the host-owned wrappers.
- Test-auth proof performs bounded local PostgreSQL and MinIO reads more than once by design so a marker cannot be trusted indefinitely.
- Successful gallery evidence is retained per invocation and requires explicit manifest/image review; cleanup cannot erase a sibling run.
- Each checkout may keep its own unpublished-port verification Postgres/MinIO services and volumes; operator development and production-profile Compose projects are not adopted or modified.

## Supersession

ADR 0015 replaces invocation isolation with one destructive local Compose E2E workflow and explicitly does not support concurrent browser runs.
