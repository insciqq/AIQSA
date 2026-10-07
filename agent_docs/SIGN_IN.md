# SIGN_IN

Owner: Security and backend maintainers
Scope: External sign-in methods, their identities, IdP-managed groups and admin role, and how a sign-in ends.

## Identities And Settlement

Every external sign-in (Google, Yandex, OIDC, LDAP, SAML, trusted header) goes through one settlement; methods add only transport and claim extraction, never their own linking, admission or role rules.

- A provider subject, not mutable email, owns later login. Identities other than Google and Yandex are bound to their configured source (issuer, directory, IdP entity, trusted proxy): a known subject from another source never matches and is refused as `source_changed` until an administrator unlinks it.
- A new identity links to an existing account by normalized email only when the source asserts a verified email or the operator explicitly trusts that method's unverified ones; otherwise the result is `account_conflict`, whatever the account's state. Google links only after its `email_verified` check; Yandex keeps its historical email link.
- Groups admission with allowed groups fails closed when the groups claim is missing; an empty list admits anyone the source authenticated. Accounts are created only after admission, when the method creates users. Outcomes are stable content-free codes, and refusals that depend only on the source's claims are decided before any account is read.

## IdP-Managed Groups And Admin Role

- Group sync changes only memberships of active groups that carry an external name for that source. It never creates groups (SCIM is the explicit exception), never touches other groups, and a missing claim changes nothing. Every membership writer shares the administrator path's MCP runtime side effects.
- A source grants admin to members of its admin groups and revokes it only from admins it promoted itself; manual admins are never demoted by a source, a manual role change takes the role over, and the last active admin keeps the role with a `last_admin_kept` warning.

## Ending A Sign-In

Every sign-in that creates a session decides it through one completion seam in the transaction that creates the session (for password and invite sign-in, the one that re-checks the credential), and each session records its sign-in method.
