# ADR 0020: One Persistent Installation Stack And One Disposable Development Stack

Status: Accepted
Amends: 0002-technical-stack-nextjs-docker-postgres, 0015-lean-local-development-harness

## Context

AIQSA previously placed a bind-mounted development service in the default Compose path and kept the installable runtime behind a separate environment-tier profile with duplicated tier-prefixed configuration. That made the simplest documented command start disposable demo state, made configuration harder to understand, and made an ordinary update too easy to confuse with the destructive developer harness.

The public installation contract needs to work on one machine without a domain, SMTP, or OAuth, and an update must retain users, conversations, and uploaded objects. Developer tests still need deterministic auth, Fake QSA, and a disposable seed, but those capabilities must not share the operator's default volumes.

## Decision

- `docker-compose.yml` is the one normal installation topology. `docker compose up -d --build` starts the standalone non-root app, applies committed migrations, runs the fail-closed idempotent installation bootstrap, and uses named Postgres and MinIO volumes.
- There are no environment-tier profiles, tier-suffixed services, or tier-prefixed settings. Operator-facing settings have one canonical name regardless of whether the app is bound to loopback or placed behind a domain and TLS proxy.
- The default application publication is loopback HTTP. A domain, TLS proxy, SMTP, Google OAuth, and Yandex OAuth are optional additions configured explicitly.
- Migrations and bootstrap run in a separate one-shot non-root tools image. The long-running runtime image contains neither Prisma CLI nor migration source.
- Installation bootstrap distinguishes a fresh schema from an adopted installation. It creates no demo data, preserves operator-owned data on rerun, and uses the normalized initial-admin email as the stable adoption key; an explicit initial user UUID is optional and, when supplied, is enforced.
- `docker-compose.dev.yml` is the explicit development and test topology. It has its own Compose project and named volumes, bind-mounts source, enables deterministic test-only switches, and may be reset or polluted under ADR 0015. Routine agent checks and Playwright use this file, never the installation stack.

## Consequences

- Clone/copy-env/up is both the beginner path and the real persistent installation path.
- Pulling code and rebuilding containers preserves named database and object volumes; migrations and bootstrap must remain backward-compatible and idempotent.
- Localhost installation is a supported runtime even though the compiled Next.js artifact uses framework `NODE_ENV=production`; cookie and readiness policy therefore derive from the explicit application URL and security settings instead of a named environment tier.
- Disposable test credentials and Fake QSA remain useful to contributors but are absent from normal onboarding and cannot be enabled by the default stack.
- Commands in development documentation and the agent harness must include `-f docker-compose.dev.yml`; commands in user installation documentation use the default Compose file.
