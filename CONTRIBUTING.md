# Contributing to AIQSA

Thanks for helping improve AIQSA. For a substantial product or architecture change, please open an issue first so the intended behavior and scope are clear.

## Development setup

AIQSA uses a separate disposable development stack. Follow [Development](docs/development.md) and always name `docker-compose.dev.yml` for development or test commands; the default Compose file is the persistent operator installation.

Before opening a pull request:

```bash
docker compose -f docker-compose.dev.yml exec -T app npm run check
```

Keep changes focused, add tests when behavior changes, and update the owning documentation when configuration, architecture, deployment, or user-visible behavior changes. Real provider credentials are not required for routine checks and must never be committed.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-only license](LICENSE).
