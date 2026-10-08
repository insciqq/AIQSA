# SIGN_IN

Owner: Security and backend maintainers
Scope: External sign-in methods, their identities, IdP-managed groups and admin role, and how a sign-in ends.

## Identities And Settlement

Every external sign-in (Google, Yandex, OIDC, LDAP, SAML, trusted header) goes through one settlement; methods add only transport and claim extraction, never their own linking, admission or role rules.

- A provider subject, not mutable email, owns later login. Identities other than Google and Yandex are bound to their configured source (issuer, directory, IdP entity, trusted proxy): a known subject from another source never matches and is refused as `source_changed` until an administrator unlinks it.
- Only an email the source verified, or one the operator explicitly trusts for that method, links a new identity to an existing account by normalized email, counts for access rules or becomes a new account's address. Otherwise linking is `account_conflict`, whatever the account's state, and a new account gets no email, so a later verified sign-in or registration for that address never lands in it. Google links only after its `email_verified` check; Yandex keeps its historical email link.
- Groups admission with allowed groups fails closed when the groups claim is missing; an empty list admits anyone the source authenticated. Accounts are created only after admission, when the method creates users. Outcomes are stable content-free codes, and refusals that depend only on the source's claims are decided before any account is read.

## Settings And Switches

Only administrators configure sign-in methods, in the admin panel: a draft validated by the method's contract, a test of exactly that draft (for methods with a tester), then activation; disabling keeps the configuration. Secrets are write-only: one envelope per method under the encryption purpose `auth-sign-in:<method>`, never returned or rendered; a blank field keeps the stored value and only an explicit clear removes it. Outcomes, test results and health are content-free codes.

- An active admin configuration wins. The Google and Yandex environment variables are a fallback only while no admin configuration of that provider is active; an enabled configuration that cannot be read keeps its method off instead of falling back. Login pages and method handlers read methods only through `resolveSignInMethods()`, whose short process-local snapshot is dropped on every activation and disable (one replica).
- A method task registers its server definition in `lib/server/auth/signInSettings/methods.ts` and its card in `components/admin/signIn/signInMethodCards.ts`. Its `identitySource` hook must return exactly the source its handler passes to settlement: activating a draft whose source differs from existing identities' needs the administrator's confirmation naming how many stop signing in, and the recovery is unlinking those identities on the user page.
- Password sign-in off refuses every local-password operation (login, a pending password second-factor step, registration and its password step, password invitation acceptance, password reset request and completion) with `password_login_disabled` and hides the forms; the bootstrap token login is unaffected. A directory sign-in sharing the password form branches off before that refusal. Registration off refuses self-service access requests; invitations still work.
- Lockout guard: password sign-in can be switched off only from a session whose sign-in method is an external method that is active right now, and while it is off that session cannot disable its own method (unless the environment fallback keeps it active); both refusals are `password_login_lockout_risk`. Both writers lock the policy row before the method row. The bootstrap token stays the break-glass sign-in.

## IdP-Managed Groups And Admin Role

- Group sync changes only memberships of active groups that carry an external name for that source. It never creates groups (SCIM is the explicit exception), never touches other groups, and a missing claim changes nothing. Every membership writer shares the administrator path's MCP runtime side effects.
- A membership is managed while its group has an external name for a source the user has an identity of, or SCIM pushes the group. Administrators cannot change it manually (`group_membership_managed`): the next sign-in or push would undo it.
- A source grants admin to members of its admin groups and revokes it only from admins it promoted itself; manual admins are never demoted by a source, a manual role change takes the role over, and the last active admin keeps the role with a `last_admin_kept` warning.

## Ending A Sign-In

Every sign-in that creates a session decides it through one completion seam in the transaction that creates the session (for password and invite sign-in, the one that re-checks the credential), and each session records its sign-in method.

## Two-Factor Sign-In

TOTP is optional per user and covers only the sign-ins AIQSA verifies itself: password and LDAP. Google, Yandex, OIDC, SAML and the trusted header rely on the identity provider's MFA; accounts that only use one see no setting. Invite acceptance needs no code, and the bootstrap token is the break-glass path that never asks for one.

- A verified first factor of a user with a confirmed factor creates no session, only a short-lived signed challenge bound to the password hash (or LDAP identity) and the factor state. The second step re-checks both, the account and the code in the transaction that issues the session; a code counts once per step, a recovery code once, and any success makes earlier challenges stale. Code guesses are limited per source and per account.
- A new secret replaces the active one only after it is confirmed, and starting that replacement, new recovery codes and turning TOTP off each need a current code or a recovery code. Password reset by email never touches the factor. An administrator reset removes the factor and its codes and ends every session of the user; it is refused for the administrator's own account.
- Secrets live in purpose-bound envelopes under the encryption key, and recovery codes only as hashes keyed from it, so losing that key blocks password and LDAP sign-in of users with TOTP until an administrator resets their factor.

## OpenID Connect

One OIDC connection rides the shared OAuth start and callback (signed flow cookie, PKCE S256, state, nonce, rate limits). Its identities are bound to the configured issuer.

- Discovery must name that issuer exactly and offer the code flow and, when it lists challenge methods, `S256`. Issuers that admit any tenant (`{tenantid}`, Entra `common`, `organizations`, `consumers`) are refused by the tester and at sign-in. The tester also probes the client credentials with an unknown code.
- An id token counts only when a key from the issuer's JWKS signed it with RS256/384/512, PS256 or ES256/384 (never `none` or HS*), with exact `iss`, `aud` containing the client, `azp` equal to the client when present or when there are several audiences, the flow's nonce, and `exp`/`iat` within 60 s. Userinfo must name the same `sub`.
- `email_verified` counts only as `true` or `"true"`. Groups at the claim path are strings; over 1 000 values, a value over 512 characters or an Entra overage pointer mean the claim is missing.
- Codes and tokens live only in the exchanging request: never stored, logged, returned or recorded in health.
- IdP logout revokes the local session first, then sends the browser to the end-session endpoint with `client_id` and `post_logout_redirect_uri=<base>/login`, without `id_token_hint`, since no id token is kept. Auto-redirect skips `/login?local=1` (the administrator's way back), shown outcomes, expired sessions and invitation, reset or verification links.
- IdP requests follow the personal MCP address policy with the LAN allowed: metadata, link-local and AIQSA's own services stay unreachable, plain HTTP stays private, and redirects are refused.

## Trusted Header

Sign-in from an authenticating reverse proxy's identity headers exists only in trusted-proxy client identity mode (`AIQSA_TRUST_PROXY_HEADERS` with a loopback bind), which only the environment sets; the admin panel shows the mode and cannot enable it. In any other mode the method's test fails, activation is refused and the sign-in route never reads the headers, checked on every request.

- The proxy must authenticate every request it forwards and overwrite any identity header the client sent. Any path to AIQSA around the proxy lets anyone sign in as anyone.
- The proxy is the authority for the email: it counts as verified and is the identity's subject under the source `trusted-header`, so a changed address is a new identity, linked by email under the settlement rules.
- Header values are bounded before use (email 320 and name 160 characters, groups 4 KiB and 200 values); an oversized or malformed header refuses the sign-in, and a missing email header says the proxy provided no identity.
- Without a session, `/login` goes straight to the sign-in route unless `?local=1` or an outcome keeps it on screen.
- A sign-in arriving with a session of another account revokes that session first, whatever its outcome. Nothing re-checks the header after sign-in, and signing out of AIQSA alone signs straight back in while the proxy still vouches; on shared browsers, sign out at the proxy and in AIQSA.
- The route is a session-creating GET. A cross-site request still carries only the identity the proxy sets for that browser, so it can sign the browser's own user in, never into an account the requester picks, and it returns only to an internal path.

## Dependencies

| Dependency | Boundary/rationale |
| --- | --- |
| `uqr` | Zero-dependency QR encoder that turns the provisioning URI into module data in the browser, rendered as a React SVG path without markup injection; the URI never leaves the account settings page. |
