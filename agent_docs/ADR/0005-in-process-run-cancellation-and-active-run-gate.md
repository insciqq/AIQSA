# ADR 0005: In-Process Run Cancellation And Active-Run Gate

Status: Accepted
Amends: none

## Context

AIQSA currently runs as a single Next.js Node service under Docker Compose. Provider runs are opened from Route Handlers and streamed back to the browser through SSE. Earlier UI behavior treated generation as a single global active run, but normal multi-chat use needs independent runs in different chats while preserving same-chat ordering and cancellation.

## Decision

Use an in-process active-run controller registry for live provider streams in the current single-process runtime:

- register an `AbortController` by model-run id when a foreground provider stream starts;
- remove it when the stream exits;
- pass its `AbortSignal` through provider adapters and fetch-backed clients;
- on explicit cancel, first compare-and-set the owned durable run from an active status to `cancelled`; only that winning request may abort the local controller or call provider-native cancel when the adapter and response id support it;
- when completion or another terminal writer wins first, return the actual persisted status without aborting local/provider execution or claiming cancellation;
- enrich a won cancellation with provider-cancel success/failure preview through a separate update guarded by durable `status = cancelled`; provider cancellation remains best effort and cannot reverse the terminal winner.

Enforce a server-side per-chat active-run gate before creating send/regeneration runs. Send/regenerate first sweeps boot-orphaned active rows and reconciles stale active rows for the current user. The fast pre-check rejects a current user's new run for the same chat with `409 active_run_in_progress` when that chat has a recent active run in `streaming`, `queued`, or `in_progress`, while allowing different chats to run concurrently.

Keep `userId` denormalized on `ModelRun` for ownership queries and reconciliation. Make the per-chat invariant atomic in Postgres with the partial unique index `ModelRun_one_active_per_chat_idx` on active statuses (`queued`, `streaming`, `in_progress`). Keep the pre-check for a friendly response, but map insert-time unique conflicts to the same `409 active_run_in_progress` response.

## Consequences

- Stop works for fake, Anthropic, OpenRouter, and OpenAI-before-response-id runs by aborting the local stream path instead of depending solely on provider-native cancellation.
- OpenAI background cancellation still uses the provider cancel endpoint when a response id is available.
- Completion and cancellation are mutually exclusive durable writers. Concurrent cancel requests have at most one side-effectful winner; later requests receive the current status without duplicating controller/provider work.
- The registry is not a distributed lock. Multi-instance runtime would need durable locking or external coordination before horizontal scaling.
- The same-chat active-run gate is no longer best-effort: concurrent send/regenerate inserts settle through the database unique index.
- The client run lifecycle tracks in-flight streams per chat and surfaces the selected chat's stream in Details/Stop controls, so background chat streams do not disable unrelated chats.
- Prisma status-guarded writes remain the durable source of truth, so completion/cancel/failure races settle before process-local or provider-native side effects.
