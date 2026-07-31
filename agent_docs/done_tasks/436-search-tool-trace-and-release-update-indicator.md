# 436-search-tool-trace-and-release-update-indicator

Status: done
Completed: 2026-07-31
Depends on: none

## Goal

Persist provider search operations for nested tool-call inspection and notify administrators about newer public releases

## Scope

- Preserve a bounded provider-operation trace for each client Search execution
  when the upstream adapter reports `web_search_call` activity.
- Relate every Search execution to its originating model tool call without
  parsing opaque invocation ids, and expose a typed, client-safe nested
  projection through chat and model-run reads.
- Extend the existing Run receipt disclosure to show
  `tool -> Search execution -> provider operation`, including the engine query,
  status, duration, source count, and provider-reported search/open/find detail.
- Compare the running package version with the latest successfully published
  stable GitHub Release through one bounded server-side cached check and expose
  a quiet admin-only update indicator in the Control Center header.
- Update the owning ADR, QSA/backend/frontend/release/testing contracts and
  deterministic regression coverage.

## Out Of Scope

- Automatic image pulls, migrations, restarts, deployment, or rollback.
- Git tags which have not yet produced a successful public GitHub Release.
- GitHub credentials, arbitrary administrator-authored update URLs, release
  channels, or prerelease opt-in.
- Persisting raw provider responses, reasoning, headers, credentials, or
  unbounded URLs/source payloads as provider operations.
- Retrofactively reconstructing provider operations absent from historical
  Search-run evidence.

## Acceptance Criteria

- A new Responses-backed client Search run durably retains at most the reviewed
  operation limit, with allowlisted operation kind/status and bounded optional
  query/queries/URL/pattern fields; a provider omission is represented as
  unavailable detail rather than zero operations.
- Chat detail, terminal chat updates, and authenticated model-run reads return
  the same typed Search execution detail nested under the exact originating
  `ThreadToolActivity`; malformed/oversized persisted JSON fails closed.
- `Used tools` expands into rounds, `search_selected_engines` (or an individual
  Search tool) expands into its engine executions, and each execution expands
  into provider operations without duplicating the standalone Search summary.
- Existing historical Search rows remain readable and show their saved engine
  query/details even when provider-operation detail is unavailable.
- Active administrators see current version metadata and an `Update available`
  status only when a newer stable, successfully published release exists;
  non-admins receive no update endpoint data.
- The release check uses the fixed official public repository, needs no token,
  is cached installation-side, validates/bounds the response, compares SemVer
  correctly, and fails quietly without affecting Control Center availability.
- Focused server/domain/contract/component tests, the required browser slice,
  documentation checks, and the routine Compose application check pass.

## Tests

- Focused Search executor, artifact projection/decoder, chat repository,
  model-run repository, release-check service/handler, admin API/controller,
  and component tests.
- Reusable-server Playwright coverage for the nested tool/Search disclosure and
  the admin update indicator at desktop and compact widths.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.

## Done Notes

- Added a bounded, allowlisted provider-operation trace for Responses-backed
  client Search executions. Search evidence now carries the configured engine
  name, engine query, status, duration, source count, and—when the provider
  reports it—ordered `search`, `open_page`, and `find_in_page` operations with
  exact bounded queries, URLs, and patterns. The trace is capped by both count
  and serialized size, records honest truncation, and never persists raw
  provider payloads, headers, credentials, reasoning, or opaque invocation ids.
- Projected the same typed Search execution detail from live inspection,
  terminal chat artifacts, and authenticated model-run reads under the exact
  originating tool call. Historical evidence remains readable and explicitly
  reports provider-operation detail as unavailable instead of claiming that no
  operations occurred; malformed or oversized nested evidence fails closed.
- Extended the Run receipt into the requested nested disclosure hierarchy:
  tool call -> Search engine execution -> provider operations. The UI includes
  engine and provider/model context, avoids a duplicate standalone Search
  summary, and keeps long query/URL content contained at desktop and compact
  widths.
- Added a passive active-admin-only release status endpoint and Control Center
  header indicator. The server compares the installed package SemVer with the
  latest stable published GitHub Release from the fixed public AIQSA repository,
  validates and bounds the response, coalesces concurrent reads, uses ETag and
  installation-side freshness/failure caches, and fails quietly. It needs no
  GitHub token and performs no pull, migration, restart, or deployment action.
- Accepted ADRs 0047 and 0048 and updated the owning architecture, backend,
  frontend, pipeline, security, and testing contracts.
- Verification passed: the complete
  `docker compose -f docker-compose.dev.yml exec -T app npm run check` at 330
  passed files / 2,773 passed tests with 14 opt-in skips; focused Search
  persistence repository coverage at 32/32; focused Chromium coverage for the
  nested Search trace and update indicator at desktop and 390 px at 2/2; docs
  check and diff check.
- Published stable Release `v0.1.13` from commit `8eeff47` through successful
  GitHub Action `30660309355`. All stable GHCR aliases resolve to one
  `linux/amd64` plus `linux/arm64` manifest digest; the pulled image is non-root,
  reports package version `0.1.13`, and carries the exact release revision.
- The guarded selected-installation rollout found zero active runs, verified a
  coordinated pre-migration backup, completed adopted bootstrap, and remained
  ready with zero restarts and no pending deployment. The prior release remains
  the recorded rollback point.
- Authenticated production Chromium proved installed/latest version `0.1.13`,
  a quiet `current` release state, no false update notice, and no desktop or
  compact horizontal overflow, console errors, or page errors. The anonymous
  release endpoint was denied.
- One bounded real Search smoke produced exactly one Search tool call, one
  engine execution, one provider-native operation, and one provider-reported
  query. Its disposable chat was archived, the account defaults compared equal
  before and after, the active-run count returned to zero, and the independent
  companion MCP deployment was unchanged and healthy.
