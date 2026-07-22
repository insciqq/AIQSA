# Development

The normal `docker-compose.yml` is the persistent user installation. Development and automated tests use `docker-compose.dev.yml`, a separate Compose project with separate database and object-storage volumes.

Do not point the development stack at an installation database or bucket. Its seed and browser tests are intentionally disposable and may reset data.

## Start the development stack

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml ps
```

Open [http://localhost:3000](http://localhost:3000). The development stack enables its committed local fixture and deterministic Fake QSA provider for tests; neither is part of the normal installation or `.env.example`.

Source code is bind-mounted into the application container, so normal edits are picked up by Next.js. The dev service blanks provider and OAuth credentials even when the normal installation `.env` contains them. For an intentional one-off adapter smoke, pass only the required key explicitly, for example `docker compose -f docker-compose.dev.yml run -e OPENAI_API_KEY ...`; routine automated tests use Fake QSA and never make paid calls.

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

Reset only the development data:

```bash
docker compose -f docker-compose.dev.yml down -v
```

The separate Compose project keeps this reset away from the persistent volumes used by the normal installation.
