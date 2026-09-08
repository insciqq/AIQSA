# Contributing to AIQSA

Thanks for helping improve AIQSA. For a substantial product or architecture change, please open an issue first so the intended behavior and scope are clear. Everyone participating in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

AIQSA includes a disposable development stack in `docker-compose.dev.yml`. The default `compose.yaml` is a persistent installation and must not be used for tests. Follow [README.md](README.md#development) and [Environment](agent_docs/ENV_VARIABLES.md) to preserve checkout-specific configuration and data.

Before opening a pull request:

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run check:hermetic
```

Select additional database, browser, image, or dependency checks through [Testing](agent_docs/TESTING.md) when the change crosses those boundaries. Keep changes focused and test observable behavior. Update documentation only for a changed durable rule, boundary, operator contract, or rationale; ordinary implementation changes need no prose synchronization. Routine checks require no real provider credentials, and secrets must never be committed.

Maintainers can publish numbered candidates such as `v0.2.1-rc.1` after the [local release checks](agent_docs/TESTING.md#boundary-evidence). The package version must match the tag's base version. RC workflows build immediately without repeating CI test suites; stable releases keep the full checks. Unchanged infrastructure images are reused. Candidate release notes include the image overrides for following the separate `rc` channel.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-only license](LICENSE).
