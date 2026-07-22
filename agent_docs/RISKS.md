# RISKS

## Current Risks

1. The current shell is interaction-heavy.
   - Keyboard navigation, command palette, inspector modes, folders, and branch controls need focused tests when touched.

2. Provider APIs differ substantially.
   - OpenAI Responses, Anthropic Messages, and OpenRouter expose different streaming, reasoning, search, background, and usage shapes.

3. OpenAI background mode adds state-machine complexity.
   - Polling, cancellation, recovery by response id, retryable retrieve failures, and provider-side retention must stay explicit.

4. Branching is a DAG, not a flat chat list.
   - Edit/regenerate behavior depends on `parentMessageId` and `activeLeafMessageId`; code must avoid leaking sibling branches into context replay.

5. Streaming can fail halfway.
   - Partial messages, reconnects, background jobs, cancellation, and provider errors need durable statuses.

6. Active run ownership is still single-process.
   - The database now enforces one active run per chat at creation time, and boot orphan sweep clears active rows after restart. Live cancellation/progress ownership still depends on in-process controllers, so multi-replica deployments need durable run ownership before they are safe.

7. Model/pricing data is placeholder.
   - Cost estimates are useful for UI plumbing but unsafe for billing until verified against provider documentation.

8. Request/response inspection can expose sensitive content.
   - Keep raw payload retention session-only by default and redact previews where needed.

9. Uploads expand privacy and provider-surface risk.
   - S3/MinIO storage, validation, file retention, PDF text extraction, image metadata, and provider capability gates must remain server-owned. The prune command now removes old orphaned upload rows/objects, but per-user quotas and automatic scheduling still belong to the multi-user hardening track.

10. Auth and entitlements are intentionally simple.
   - Session auth must still avoid plaintext token storage, UI-only enforcement, and confused user/group grants.

11. Anonymous sharing can leak private context if widened casually.
    - Current shares are immutable sanitized snapshots; do not turn them into live private-chat access.

12. Browser visual testing can become expensive.
    - Default to Playwright CLI and inspect rendered UI only when the DOM/test output is insufficient.

13. Schema drift can destroy data if migrations are bypassed.
    - Persistent Postgres volumes must use a coordinated database/object backup followed by committed Prisma migrations and `prisma migrate deploy`; `prisma db push` is only acceptable for disposable scratch databases. The installation bootstrap is not a replacement for migration rollback and must never be substituted with the demo seed.

14. Compose service exposure is easy to misapply.
    - The default stack is persistent and publishes only the application on `AIQSA_BIND_ADDRESS`; keep Postgres/MinIO internal and use the TLS proxy template for exposed installs. Run deterministic credentials, seed, Fake QSA, and host-published datastores only through `docker-compose.dev.yml`, never by adding those switches to the installation stack.
