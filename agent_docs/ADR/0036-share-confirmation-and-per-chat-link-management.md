# ADR 0036: Share Confirmation And Per-Chat Link Management

Status: Accepted
Amends: 0004

## Context

ADR 0004 introduced `Share (anonymously)` as an immutable sanitized snapshot behind a secret link. The shipped UI published on a single click and kept the link manageable only inside a dismissible creation notice; once dismissed, the link had no user-facing surface and became effectively immortal. Snapshots also stored no source-chat association, so a per-chat listing was impossible. The 2026-07 UI/UX audit flagged both problems and left one live dev-stand link nobody could revoke from the product.

## Decision

- Sharing requires an explicit confirmation. The Share action opens a dialog that explains the sanitized-snapshot semantics; a public link is created only by the explicit create action inside that dialog.
- `SharedChatSnapshot` records a nullable `chatId` (SetNull on chat deletion). Creation stamps the source chat, and an owner-scoped listing endpoint returns the chat's live (non-revoked, non-expired) links.
- The Share dialog lists those live links with per-link revocation across sessions, replacing the notice-only lifecycle. Repeated Share opens management instead of silently minting another link.
- Tokens remain stored as hashes: the full URL is visible only immediately after creation; listed links expose creation time and revocation only. Snapshot content, sanitization, the generic unavailable page, and the immutability contract from ADR 0004 are unchanged.
- Legacy snapshots created before the chat link have `chatId = NULL`, are not listed, and remain revocable only by their original id.

## Consequences

- The former "no durable share-history UI" clause in `FRONTEND.md` is retired; per-chat live-link management is now a product capability.
- A one-column additive migration (`20260727220000_share_snapshot_chat_link`) links snapshots to chats without touching existing rows.
- The client share flow moved from `threadActions` notice choreography to a self-contained `ShareDialog`; share busy state stays scoped to share controls.
- Cross-chat/global share management remains out of scope.
