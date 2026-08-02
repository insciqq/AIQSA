# Contributing to AIQSA

Thanks for helping improve AIQSA. For a substantial product or architecture change, please open an issue first so the intended behavior and scope are clear.

## Development setup

AIQSA uses a separate disposable development stack. Follow the development section in [README.md](README.md#development) and always name `docker-compose.dev.yml` for container development or test commands; the default Compose file is the persistent operator installation. Deterministic host checks use `npm run check:hermetic`.

Before opening a pull request:

```bash
docker compose -f docker-compose.dev.yml exec -T app npm run check
```

Keep changes focused and add tests when behavior changes. Update the owning living document only when a change modifies a durable product contract, invariant, architecture/data boundary, configuration/environment contract, operator workflow, security boundary, or verification policy. A bug fix or implementation change that restores or preserves an already documented contract does not require a documentation edit. Real provider credentials are not required for routine checks and must never be committed.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-only license](LICENSE).
