<div align="center">

<img src="public/icon.svg" width="80" alt="AIQSA logo">

# AIQSA

**The self-hosted AI workspace for small and medium teams.**

GPT, Claude, Gemini, DeepSeek and your own models in one private workspace, on your own API keys.

[![Latest release](https://img.shields.io/github/v/release/insciqq/AIQSA)](https://github.com/insciqq/AIQSA/releases/latest)
[![CI](https://github.com/insciqq/AIQSA/actions/workflows/ci.yml/badge.svg)](https://github.com/insciqq/AIQSA/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Quick start](#quick-start) · [Features](#features) · [Self-hosting guide](SELF_HOSTING.md) · [Releases](https://github.com/insciqq/AIQSA/releases)

</div>


https://github.com/user-attachments/assets/95ab8feb-95bc-4e99-9439-92b5cbb8fcbb


## Why AIQSA

- **Every model in one place.** Connect OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, or any OpenAI-compatible server, including models running on your own network. Choose the model for each message; the whole team works in the same workspace.
- **Ready in minutes.** Add an API key and AIQSA checks what each model can actually do (images, PDFs, tools, web search) and turns on exactly that. There is nothing to wire together before your team starts.
- **A computer in every chat.** Each chat can get its own isolated Linux virtual machine. The model runs code, works with your files, and hands back reports, charts and archives to download. For larger jobs, give the task to a Codex agent working in the same machine.
- **Answers you can check.** A built-in Knowledge engine reads PDFs, scans and tables, finds the right passages with hybrid search and reranking, and checks the answer against the passages it cites before you see it. Web search answers come with linked sources.
- **Memory that understands, not just stores.** AIQSA learns only from what you actually say, keeps track of who each fact is about and when it was true, replaces outdated facts, settles contradictions on its own, and searches your past chats when an answer needs more. You control everything it keeps, and the same Memory works in Claude Code and Codex.
- **Work that runs on its own.** Scheduled tasks run a prompt daily, weekly or monthly and deliver the answer to its own chat, with an optional email.
- **Built for teams.** Role-based access control, shared Projects and Assistants, invitations, API keys per installation, group or person, and usage per user.

## Features

**Chat**
- Model choice per message, branching conversations, folders, and read-only share links.
- File, image and PDF attachments, read natively by models that support them.
- Artifacts: documents and interactive pages the model builds in chat, with versions and shareable links.
- Image generation.

**Knowledge**
- Document parsing with OCR for scans; vision models read PDF pages, tables and charts.
- Hybrid lexical and vector search with reranking; small collections are read in full.
- Answers are reviewed against the retrieved evidence, and each citation opens the exact passage or PDF page.
- Versioned sources shared across chats, Projects and Assistants.

**Tools and automation**
- Web search with sources.
- Workspace: an isolated KVM virtual machine per chat, with file exports and personal secrets.
- Agent mode: Codex runs long tasks inside the chat's Workspace.
- MCP: connect remote MCP servers with OAuth; Auto mode finds the right tool for the request.
- Skills: reusable instructions and files that the model loads when they are relevant.
- Scheduled tasks: once, daily, weekly or monthly runs with optional email notifications.

**Memory**
- Learns from what you say, never from model answers, quotes or documents; facts you save explicitly always take priority.
- Each fact keeps its subject, source and time. Newer facts replace outdated ones; duplicates and contradictions are settled in the background.
- Key facts reach every chat without extra model calls; search across facts and past chats covers the rest.
- Secrets such as API keys and passwords are removed before anything is saved.
- Review, edit, pause or reset it at any time.

**For Claude Code and Codex**
- Connect your coding agents to AIQSA over OAuth with one command: your team's MCP tools through the MCP Hub, your Skills, and your Memory.

**Team and administration**
- Projects with shared chats, files, instructions and Knowledge.
- Assistants with fixed instructions, models and Knowledge.
- Role-based access control: administrator and user roles, groups that decide who can use which providers, models and search, and Owner, Manager, Contributor and Viewer roles in Projects.
- Email invitations.
- Usage and cost per user.

**Operations**
- One command to install, check, upgrade, back up and restore.
- Prebuilt images and Docker Compose on a single host. No GPU required.

## Quick start

You need 64-bit Linux (amd64 or arm64) with **KVM**, Docker Engine 25.0+ with Compose 2.29.7+, 2 CPU cores, 8 GB RAM (16 GB recommended) and 50 GB of free SSD space.

> [!IMPORTANT]
> Every Workspace runs in a KVM virtual machine, so `/dev/kvm` is required. On cloud servers, enable nested virtualization or use a bare-metal host. See the full [requirements](SELF_HOSTING.md#requirements).

```bash
git clone https://github.com/insciqq/AIQSA.git
cd AIQSA
./aiqsa.sh install --base-url http://localhost:3000 --admin-email admin@example.com
```

`install` checks the host, creates `.env` with unique secrets, starts the stack and waits until it is ready. It never changes host settings: a failed check prints the command that fixes it.

Open [localhost:3000](http://localhost:3000), sign in with the administrator email and the `AIQSA_INITIAL_ADMIN_PASSWORD` from `.env`, and add an API key in the Control Center. To open AIQSA to your team over the internet, put an HTTPS reverse proxy in front of port 3000; the [self-hosting guide](SELF_HOSTING.md#install) lists the settings it needs.

## Updates and backups

```bash
./aiqsa.sh upgrade    # update to the newest release
./aiqsa.sh backup     # back up the database, files and .env
./aiqsa.sh doctor     # check the host, .env and the running stack
./aiqsa.sh logs --errors --since 1h   # recent AIQSA errors
```

Read the [self-hosting guide](SELF_HOSTING.md) before you update: it covers release tags, one-time steps for older installations, and restoring from a backup. Every release lists its changes in the [release notes](https://github.com/insciqq/AIQSA/releases).

## Project status

AIQSA is pre-1.0 and ships frequently. It runs as a single application replica on one host.

## Contributing

Development uses Node.js 22. Deterministic checks run without a database or provider credentials:

```bash
npm ci
NODE_OPTIONS=--max-old-space-size=8192 npm run check:hermetic
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the [security policy](SECURITY.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[GNU Affero General Public License v3.0 only](LICENSE). You can use, modify and self-host AIQSA freely. If you modify it and let people use your version over a network, you must offer them its source code.
