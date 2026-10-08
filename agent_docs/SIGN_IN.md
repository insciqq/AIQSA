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

## Dependencies

| Dependency | Boundary/rationale |
| --- | --- |
| `uqr` | Zero-dependency QR encoder that turns the provisioning URI into module data in the browser, rendered as a React SVG path without markup injection; the URI never leaves the account settings page. |
