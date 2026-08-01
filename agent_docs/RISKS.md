# RISKS

## Current Risks

1. The shell is interaction-heavy.
   - Command-palette shortcut safety, inspector modes, folders, branching, responsive disclosure, and async ownership need focused functional tests when touched. Dedicated WCAG and accessibility-conformance work remains separately scoped.

2. Provider APIs differ substantially.
   - OpenAI Responses, Anthropic Messages, and OpenRouter expose different streaming, reasoning, search, background, tool, and usage shapes; keep those differences inside adapters.

3. Native background mode adds state-machine complexity.
   - Polling, cancellation, recovery by provider response id, retryable retrieval failures, tool continuation, and provider-side retention must stay explicit.

4. A conversation is a message DAG, not a flat list.
   - Edit/regenerate behavior depends on `parentMessageId` and `activeLeafMessageId`; context replay must never include sibling branches.

5. Streaming and tool execution can fail after partial external work.
   - Partial messages, durable tool-call rows, crash-ambiguous side effects, reconnect, cancellation, and provider errors need monotonic terminal settlement and inspectable evidence.

6. Live run and MCP coordination is still process-local.
   - Database guards prevent duplicate active runs and persist desired MCP generations, but live controllers, sessions, cancellation, and progress ownership are not safe for multiple app replicas without a durable ownership design.

7. Model pricing is operator-maintained estimate data.
   - Stored estimates are useful for compatibility and planning but are unsafe for billing until provider/model prices and source labels are verified.

8. Inspection can expose sensitive content.
   - Keep raw payload retention session-only by default and keep durable previews, errors, tool arguments/results, and account labels bounded and redacted.

9. Uploads widen both storage and provider disclosure boundaries.
   - Storage, validation, extraction, retention, capability gates, and resource limits must remain server-owned. Client Search currently accepts only a bounded generated query and fails closed for attachment-bearing runs before provider dispatch; new Search adapters and recovery paths must preserve that incompatibility until a separately reviewed per-run disclosure-consent contract exists.

10. Auth and entitlement transitions remain concurrency-sensitive.
    - Password/reset/activation/admin decisions use explicit locks and transactions, and authentication admission uses atomic durable PostgreSQL buckets keyed by installation-secret HMACs. New authentication routes remain risky if they bypass the shared limiter, weaken transactional ownership checks, or derive client identity from an unvalidated proxy chain.

11. Administrator-selected MCP code is trusted infrastructure.
    - Server grants authorize every exposed tool without per-call approval; local workloads have outbound network access, and ToolHive's Docker authority plus the app's private controller access make an app/controller compromise a host compromise.

12. Anonymous sharing can leak private context if widened casually.
    - Current shares are immutable sanitized snapshots; do not turn them into live private-chat access or add attachment/provider internals to snapshots.

13. Browser visual testing can become expensive.
    - Keep browser integration in focused Playwright CLI tests and inspect rendered states only when DOM/test evidence is insufficient.

14. Schema drift can destroy persistent data.
    - Persistent installs require coordinated database/object backup plus committed Prisma migrations and `prisma migrate deploy`; `prisma db push` and the demo seed are disposable-development tools only.

15. Compose targets are easy to confuse.
    - Default Compose is the persistent installation. Deterministic credentials, Fake QSA, destructive checks, seed, and host-published datastores belong only to explicit `docker-compose.dev.yml` commands.
