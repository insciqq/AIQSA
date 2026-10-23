---
paths:
  - "lib/server/auth/**"
  - "app/login/**"
  - "app/saml/**"
  - "app/scim/**"
  - "components/admin/signIn/**"
  - "tests/auth-idp/**"
---
# Sign-in

External sign-in methods (Google, Yandex, OpenID Connect, LDAP, SAML, trusted header), SCIM provisioning and two-factor sign-in. Code: `lib/server/auth/` with one subdirectory per method (`lib/server/auth/oidc/`, `lib/server/auth/ldap/`, `lib/server/auth/saml/`, `lib/server/auth/scim/`, `lib/server/auth/trustedHeader/`) and the settings in `lib/server/auth/signInSettings/`; admin cards in `components/admin/signIn/`; IdP interoperability tests in `tests/auth-idp/`.

## Identity settlement

- Every external method goes through one identity settlement (`lib/server/auth/externalIdentity.ts`) and one completion seam (`lib/server/auth/signInCompletion.ts`) inside the transaction that creates the session. A method adds only transport and claim extraction, never its own linking, admission or role rules.
- The provider's subject, not the email, owns later logins. Identities other than Google and Yandex are bound to their configured source (issuer, directory, IdP entity, trusted proxy); a known subject from another source is refused as `source_changed` until an administrator unlinks it, so a reconfigured or second IdP cannot take over accounts.
- Only an email the source verified, or one the operator explicitly trusts for that method (`trustUnverifiedEmail`), may link to an existing account, count for access rules or become a new account's address. Otherwise linking fails as `account_conflict` and a new account gets no email. Google links only after `email_verified`; Yandex keeps its historical email link; LDAP trusts its directory by default; SAML never asserts a verified email; the trusted-header proxy is the email authority.
- One exception: an account SCIM provisioned, with no sign-in identity yet and not an administrator, links its first identity of the method chosen on the SCIM card by email even without email trust.
- With allowed groups configured, a missing groups claim fails closed; an empty list admits anyone the source authenticated. Accounts are created only after admission, and refusals that depend only on claims are decided before any account is read.

## Settings and switches

- Only administrators configure methods: a draft, a test of exactly that draft, then activation. Secrets are write-only envelopes under the encryption purpose `auth-sign-in:<method>`; a blank field keeps the stored value.
- An active admin configuration wins. `AIQSA_GOOGLE_OAUTH_*` and `AIQSA_YANDEX_OAUTH_*` are a fallback only while no admin configuration of that provider is active; an enabled configuration that cannot be read keeps the method off instead of falling back. Read methods only through `resolveSignInMethods()`.
- A new method registers its definition in `lib/server/auth/signInSettings/methods.ts` and its card in `components/admin/signIn/signInMethodCards.ts`. Its `identitySource` must return exactly the source its handler passes to settlement; activating a draft with a different source asks the administrator to confirm how many people stop signing in.
- Password sign-in off refuses every local-password operation (`password_login_disabled`); the bootstrap token still works. Registration off refuses self-service requests; invitations still work.
- Lockout guard: password sign-in can be turned off only from a session signed in with an external method that is active now, and while it is off no disable may end that session's method or the last active external method (an environment fallback counts). Both writers take one advisory policy lock. The bootstrap token is the break-glass sign-in.

## Groups and the admin role

- Every membership writer (sign-in sync, SCIM, the administrator editor) goes through `lib/server/auth/groupMembership.ts` and shares its MCP runtime side effects. Group sync changes only memberships of active groups that carry an external name for that source. It never creates groups (SCIM is the exception) and a missing claim changes nothing.
- Such memberships are managed: administrators cannot change them by hand (`group_membership_managed`), because the next sign-in or SCIM push would undo it.
- A source grants admin to members of its admin groups and revokes it only from admins it promoted itself. Manual admins are never demoted by a source, and the last active admin keeps the role (`last_admin_kept`).

## Refused sign-ins

Administrators see refused sign-ins on the Users page and can invite those people, because content-free telemetry cannot say who they were (operator decision 2026-10-18). A row names an email only when the source verified or the method trusts it, and names a password or second-factor refusal only by an existing account's id. An address typed for no account is never stored, so bots and typos cannot fill the journal, and the form never waits for the write, so known and unknown addresses answer alike. Never store a typed email, password, code, token, IdP payload or IP address.

## Two-factor sign-in

- TOTP covers only sign-ins AIQSA verifies itself: password and LDAP. Other methods rely on the identity provider's MFA; invite acceptance and the bootstrap token never ask for a code.
- A verified first factor creates no session, only a short-lived challenge bound to the credential and factor state; the second step re-checks everything in the transaction that issues the session.
- Changing or disabling the factor needs a current code or recovery code; email password reset never touches it. An administrator reset removes it and ends the user's sessions, and is refused for the administrator's own account.
- Factor secrets and recovery-code hashes depend on `AIQSA_ENCRYPTION_KEY`; losing the key blocks password and LDAP sign-in for TOTP users until an administrator resets their factor.

## OpenID Connect

- Identities are bound to the configured issuer, which discovery must name exactly. Issuers that admit any tenant (`{tenantid}`, Entra `common`, `organizations`, `consumers`) are refused, because any tenant's users could sign in.
- ID tokens count only with an asymmetric signature from the issuer's keys, never `none` or HS*, and exact issuer, audience, authorized party, nonce and time checks (`lib/server/auth/oidc/oidcClient.ts`).
- A namespaced groups claim (Auth0 drops a custom `groups` claim) is read by its full name before the path is split at dots; an Entra overage pointer counts as a missing claim.
- Codes and tokens live only in the exchanging request. The one stored token: while IdP logout is on, a session keeps its ID token as an envelope bound to that session, cleared on revocation and used only as `id_token_hint`. Logout revokes the local session before redirecting to the IdP.
- IdP requests follow the personal MCP address policy with the LAN allowed: no metadata, link-local or AIQSA service addresses, plain HTTP only to private addresses, no redirects.

## Trusted header

- This method exists only in trusted-proxy mode (`AIQSA_TRUST_PROXY_HEADERS` with a loopback bind), which only the environment can set. In any other mode the route never reads the headers, checked on every request.
- The proxy must authenticate every forwarded request and overwrite client-sent identity headers; any path to AIQSA around the proxy lets anyone sign in as anyone. Nothing re-checks the header after sign-in.
- Signing out lands on `/login?local=1`, because a plain `/login` would sign the browser straight back in while the proxy still vouches.
- The route is a session-creating GET. That is acceptable because a cross-site request carries only the identity the proxy sets for that browser and returns only to an internal path.

## LDAP

- LDAP shares the login form. While password sign-in is on, an email with a usable local password keeps it (break-glass accounts); everything else goes to the directory.
- Empty passwords are refused before any network I/O, because directories treat a DN bind without a password as a successful unauthenticated bind.
- The name is RFC 4515-escaped, the search must find exactly one entry, and only that DN is bound. Unknown names, ambiguous searches and wrong passwords give the same answer after the same delay.
- Identities are bound to the directory host and user search base, so scheme and port changes keep them.

## SAML

- SP-initiated only. IdP-initiated SSO, Single Logout and encrypted assertions are unsupported.
- The ACS (`/saml/acs`) lives outside `/api` because the IdP's cross-site POST carries no `Lax` cookies and would fail the `/api` origin guard. XML is bounded before canonicalization and DTDs are refused.
- Pending requests live in process memory (single replica). A response must answer a pending request, so unsolicited assertions are refused, and only the same-site completion step carrying the browser's cookie issues the session, so a replayed response signs nobody in.
- Signatures verify only against pinned certificates, never `KeyInfo`; SHA-1 needs `allowSha1`; HMAC is refused.
- IdP metadata is fetched only when an administrator imports or tests a metadata URL, through the pinned transport with private networks allowed and AIQSA services and cloud metadata refused. Sign-in itself makes no server request to the IdP.

## SCIM

- `/scim/v2` is an admin-level integration outside `/api`. Its client sees every user and active group and changes accounts and memberships only through the commands the administrator paths use. `DELETE` never erases. Every token failure, and SCIM being off, gets the same 401.
- SCIM never changes the email of an administrator or an account with a local password. It is the only path that creates groups; Full access links only by its exact name and is never renamed or archived.
- Deactivation revokes sessions and inbound MCP grants at once, under `disableUser`'s guard: the last administrator who can sign in stays. Reactivation re-enables only accounts SCIM disabled; an administrator's disable wins.

## Dependencies

| Dependency | Why |
| --- | --- |
| `uqr` | Zero-dependency QR encoder; the TOTP provisioning URI is rendered as a React SVG path and never leaves the page. |
| `ldapts` | Server-only LDAP client (`ldapjs` is decommissioned). It gets a socket AIQSA opened to a policy-checked address. Its errors can echo filters, so they are never logged or returned. |
| `@node-saml/node-saml` | Floor 5.1.0 for CVE-2025-54419. AIQSA adds the request binding, destination, recipient, issuer, algorithm and replay checks it lacks. |
| `xml-crypto` | node-saml's signature verifier, pinned directly and by override; floor 6.1.2 for signature bypasses. |
| `@xmldom/xmldom` | Parses untrusted SAML XML, also inside node-saml and xml-crypto; override floor 0.8.15 for parser advisories. |
