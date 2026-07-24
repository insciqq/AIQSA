# Development

The normal `docker-compose.yml` is the persistent user installation. Development and automated tests use `docker-compose.dev.yml`, a separate Compose project with separate database and object-storage volumes.

Do not point the development stack at an installation database or bucket. Its seed and browser tests are intentionally disposable and may reset data.

## Start the development stack

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml ps
```

Open [http://localhost:3000](http://localhost:3000). The development stack enables its committed local fixtures and deterministic Fake QSA provider for tests; none is part of the normal installation or `.env.example`.

The disposable development logins are:

- administrator: `operator@aiqsa.local` / `AIQSA-local-2026!`;
- MCP member: `mcp-member@aiqsa.local` / `AIQSA-mcp-member-2026!`;
- restricted member: `restricted-member@aiqsa.local` / `AIQSA-restricted-member-2026!`.

The two ordinary accounts make permission checks reproducible. Both see the group-granted `Fixture Shared MCP`; only MCP Member may edit its `Fixture workspace` field and see the directly granted `Fixture Private MCP`. These known credentials and fixed MCP definitions are repaired by the guarded local seed and must never be used for an exposed installation.

Source code is bind-mounted into the application container, so normal edits are picked up by Next.js. The dev service does not inject legacy provider/SMTP or sign-in OAuth credentials from the normal installation `.env`. It uses a deterministic development-only encrypted-state key and a separate ToolHive volume/private network; ToolHive still receives the host Docker socket, so this stack can create real sibling containers. Intentional adapter smokes are standalone commands with an explicitly supplied key; routine application tests use Fake QSA and never make paid calls.

## Checks

Run the routine repository check inside the development container:

```bash
docker compose -f docker-compose.dev.yml exec -T app npm run check
```

Focused checks use the same container, for example:

```bash
docker compose -f docker-compose.dev.yml exec -T app npx vitest run path/to/test.ts
docker compose -f docker-compose.dev.yml exec -T app npm run lint
docker compose -f docker-compose.dev.yml exec -T app npm run typecheck
```

Browser tests reset the development database. Do not run them concurrently with another development session:

```bash
docker compose -f docker-compose.dev.yml stop app
docker compose -f docker-compose.dev.yml run --rm -T app npm run test:e2e
docker compose -f docker-compose.dev.yml up -d app
```

## Stop or reset

Stop the development containers while preserving their disposable volumes:

```bash
docker compose -f docker-compose.dev.yml down
```

Dynamic ToolHive MCP workloads are not removed by `down -v`. Before a complete development reset, remove only workloads bearing the deterministic dev installation marker:

```bash
docker compose -f docker-compose.dev.yml run --rm -T \
  app npm run mcp:cleanup -- --execute
```

Then reset only the development data:

```bash
docker compose -f docker-compose.dev.yml down -v
```

The separate Compose project and encryption key keep this reset away from the persistent volumes and ownership marker used by the normal installation.

## Public releases

The public repository is [GitHub](https://github.com/insciqq/AIQSA). Maintainer development happens in a private GitLab repository, and reviewed public snapshots are published to GitHub deliberately rather than through an automatic mirror.
