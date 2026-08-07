# BACKEND API — AUTH AND ONBOARDING

Owner: Server API contract maintainers
Scope: Observable password, session, recovery, admission, OAuth, access-request, invite, verification, and onboarding transitions.
Read when: Changing login/session/recovery routes, auth admission, OAuth, registration, invites, verification, access requests, or mail-linked auth flows.
Code owners: `lib/server/auth/`, authentication/onboarding routes, sessions, admission, OAuth, invite, and mail handlers.
Not owned here: Threat-control implementation details, administrator resources, chat/runs, or uploads/shares.

## Authentication And Onboarding

### Password sessions and recovery

- Login accepts normalized email/password credentials and returns one generic unauthorized result for invalid, unverified, inactive, or denied identities. Password verification happens before settlement; settlement locks and rechecks the exact identity state before creating a revocable database session. Password reset uses the same identity lock, so an obsolete password cannot create a post-reset session.
- Logout revokes the current session before clearing its cookie. Password-reset completion consumes the selected and sibling reset tokens, changes the password, and revokes all user sessions atomically.
- Reset request is enumeration-resistant. Eligible and ineligible plausible emails share the generic response and a small SMTP-independent response floor. An eligible token is persisted before bounded asynchronous mail delivery begins.
- The bootstrap-token route is hidden behind an explicit environment gate. Disabled recovery behaves as not found; enabled recovery maps only to the active seeded operator and creates the ordinary database-backed session type.

### Authentication admission

- Password, OAuth, onboarding, invite, verification, bootstrap, and reset
  entry/completion routes settle through the shared durable admission service
  before body or provider work. The route layer exposes only its stable
  throttled outcome; [HTTP and auth security](../../security/HTTP_AND_AUTH.md)
  owns bucket identities, HMAC persistence, proxy/peer proof, topology failure,
  and enumeration-resistance mechanics.

### OAuth

- Google and Yandex entry routes exist only when both credentials for that provider are configured. A signed, short-lived transaction binds provider, state, nonce, PKCE, callback, and sanitized internal destination before code exchange.
- Google requires a valid OIDC ID token and verified email. Yandex requires the authenticated profile subject/default email and the configured client identity. Callback results reveal only stable privacy-safe codes.
- First use merges by normalized email into the existing user. Later sign-in is owned by the stable provider subject even if the provider email changes. Conflicting subject/email bindings, inactive users, and disallowed new users receive no session.
- OAuth never consumes an invite by matching its email. Invite-token acceptance remains the activation proof. Provider access, refresh, and ID tokens, authorization codes, PKCE verifiers, raw errors, and profile bodies are not persisted.

### Access requests, invites, and verification

- The registration endpoint is an access request, not public signup. It accepts
  no password, creates or reuses only an eligible unverified identity, replaces
  the prior open verification token, and returns one generic result behind the
  shared response floor without revealing account existence or mail outcome.
  Eligible mail is dispatched asynchronously after token persistence; delivery
  failure remains administrator-visible rather than caller-visible.
- Direct invite acceptance trusts the token-bound email, never a browser-supplied email. One transaction consumes the open invite, creates or completes the matching identity, sets the chosen password, verifies and activates the user with invite defaults, invalidates sibling verification links, and creates the first session. All invalid, expired, revoked, accepted, raced, or already-settled cases share the stable invalid-invite outcome.
- Email verification requires the one-time token and a new valid password. One transaction consumes sibling verification tokens, establishes the password identity, and applies any current access rule or invite. Without current admission, the verified user remains pending for administrator action.
- Verification, reset, and invited-user mail resolve one active database SMTP snapshot per send. Transport enforces the selected TLS mode and bounded deadline. Test capture takes precedence over real delivery; raw transport output is not exposed.
