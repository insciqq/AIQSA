# ADR 0008: Multi-User Auth Uses Email Password, Verified Access Requests, And Stateful Sessions

Status: Accepted
Amends: none

## Context

AIQSA is moving from a single-operator private token app to a small self-hosted multi-user deployment. At the start of this ADR, the existing `User`, `Group`, `UserGroup`, and `AccessGrant` tables already gave the app a user-scoped data and entitlement model, but the front door was still a shared bootstrap token with stateless signed cookies.

The first multi-user release needs individual accounts, revocable sessions, a safe registration gate, and an identity shape that can later attach Google or Yandex OAuth without replacing user-owned chats, runs, uploads, prompts, groups, or grants.

## Decision

Use in-app email/password auth for the first multi-user release.

Every private app session must belong to an active `User`; pending, disabled, denied, unverified, or unapproved users must not reach private app APIs. Email verification is mandatory before private access.

Self-service registration is an access request, not open public signup. A verified registration becomes active only through one of these approval paths:

- exact approved normalized email;
- exact approved normalized domain;
- one-off invite for the normalized email;
- explicit admin approval of a pending user.

Admins manage pending users, approved emails/domains, one-off invites, user disable/offboard, and session revocation. `User.role` starts with `admin` and `user`; `User.status` starts with `pending`, `active`, `disabled`, and `denied`.

Sessions are opaque random tokens stored in the browser as HttpOnly cookies and stored in the database only as token hashes. Logout, password reset, user disable/offboard, and admin session actions revoke database sessions.

Provider identities are modeled separately from `User` through `AuthIdentity`. The first provider is `password`; future providers are `google` and `yandex`. Identities store provider account id, normalized email, verification timestamp, and password hash only where relevant. OAuth providers may attach later to the same user/entitlement model without changing ownership fields on chats, runs, uploads, prompts, folders, or grants.

The bootstrap-token login path is removed from normal multi-user mode. It remains only as an explicitly env-gated recovery route and must map to the existing bootstrap operator user id, which is seeded/migrated as an active admin.

## Consequences

- Auth rollout was split safely: schema/env foundation, DB-backed sessions, password login/reset, registration/verification/approval, admin UI, and final bootstrap removal/recovery gating.
- Token-like verification, reset, invite, and session secrets are stored by hash only.
- Email and domain comparison must use normalized exact matches. `example.com` must not match `badexample.com`; subdomain behavior must be explicit in later approval code.
- SMTP and public app-base-url configuration are part of the auth contract before mail sending routes exist.
- The existing user/group entitlement model remains the authorization base for catalog and model-run access.

## Addendum (2026-07-18)

Google and Yandex identities are now implemented through provider-specific
authorization-code callbacks rather than a general auth framework. A first
provider identity attaches to the existing `User` with the same normalized
provider email, so password and OAuth entry points keep one ownership root for
chats, runs, uploads, settings, prompts, groups, and grants. Later login resolves
the stable provider account id and does not rematch a changed email.

Google merge requires its signed OIDC `email_verified=true` claim. Yandex does
not expose an independent verification flag, so this small self-hosted product
deliberately accepts `default_email` only from the authenticated profile whose
returned client id matches the configured application. New OAuth users still
need an exact email/domain rule. The token-bearing invite path is not weakened
into an email-only match. State, PKCE, Google nonce, and short-lived signed flow
cookies are mandatory; provider tokens are not persisted because AIQSA uses
these providers only for sign-in.
