# AIQSA

[![Latest release](https://img.shields.io/github/v/release/insciqq/AIQSA)](https://github.com/insciqq/AIQSA/releases/latest)
[![CI](https://github.com/insciqq/AIQSA/actions/workflows/ci.yml/badge.svg)](https://github.com/insciqq/AIQSA/actions/workflows/ci.yml)

AIQSA is a self-hosted, multi-user web interface for working with models from different providers. It combines chat, Projects, Assistants, files, document search, personal Memory, and MCP tools.

![AIQSA chat interface](.github/assets/aiqsa-chat.png)

## Features

- OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, and OpenAI-compatible endpoints, with model selection per message.
- Branching conversations, folders, file attachments, and read-only share links.
- Team Projects, reusable Assistants, invitations, and access groups.
- Knowledge bases with document search, OCR, and source citations.
- Web search, MCP tools, and personal Memory accessible from AIQSA or external MCP clients.
- An optional KVM sandbox for running commands and working with files.

AIQSA is pre-1.0 and designed for small, operator-managed installations with a single application replica.

## Quick start

Docker and Docker Compose are required. The included stack is for disposable local development; production deployment is maintained separately by the installation operator.

```bash
git clone https://github.com/insciqq/AIQSA.git
cd AIQSA
docker compose -f docker-compose.dev.yml up -d --build app
```

Open [localhost:3000](http://localhost:3000). The development stack supplies test credentials. See [.env.example](.env.example) for optional overrides.

**v0.2.0 requires a fresh database.** There is no upgrade path from v0.1.x, including v0.1.24. Remove the old database before initializing v0.2.0; existing data is not migrated.

Published images are available on [GHCR](https://github.com/insciqq/AIQSA/pkgs/container/aiqsa); release notes include their immutable digests.

## Development

Use Node.js 22. Deterministic checks run without a database or provider credentials:

```bash
npm ci
NODE_OPTIONS=--max-old-space-size=8192 npm run check:hermetic
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and verification guidance.

## Further reading

- [Architecture and integrations](human_docs/architecture.md)
- [Personal Memory through MCP](human_docs/personal-memory-mcp.md)
- [Security reporting](SECURITY.md) and [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[GNU Affero General Public License v3.0 only](LICENSE).
