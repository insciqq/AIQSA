# ADR 0002: Technical Stack Is Next.js, TypeScript, Docker Compose, Postgres

Status: Accepted
Amends: none

## Context

AIQSA needs a frontend, backend API routes, streaming, provider adapters, persistence, and cheap automated checks. A single-language stack keeps autonomous implementation simpler.

## Decision

Use:

- TypeScript on Node.js.
- Next.js App Router for the web app.
- Next.js Route Handlers on Node runtime for backend APIs.
- Tailwind CSS and `lucide-react` for UI.
- Postgres with Prisma for persistence.
- Docker Compose for local runtime and checks.
- Vitest, Testing Library, and Playwright CLI for tests.

Do not split a separate backend service until Next.js Route Handlers become a real blocker.

## Consequences

- Shared TypeScript domain modules can be used by routes, providers, UI, and tests.
- Docker Compose becomes the expected verification path after scaffold.
- Provider SDK calls stay behind internal adapters.
- The first implementation can be local-first and single-user while preserving `userId` in the schema for later auth.
