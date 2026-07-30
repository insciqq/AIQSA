# 432-search-provider-control-truth

Status: done
Completed: 2026-07-30
Depends on: none

## Goal

Make Search availability, timeouts, and provider setup summaries truthful

## Scope

- Make Search readiness dependency-aware and keep unavailable hosted engines
  out of user catalogs without coupling the product to a specific deployment.
- Make the per-engine Search timeout a first-class Search setting with a
  practical multi-minute default and an end-to-end transport deadline.
- Surface sanitized summaries of already configured provider connections on
  the Providers landing view and deep-link each summary to its connection.
- Reconcile the selected production installation's stale system Search state,
  publish the verified release, deploy it, and run sanitized production smoke.

## Out Of Scope

- Unrelated product changes.
- Provider-specific hostname, organization, deployment, or model-id branches.
- A redesign of the provider connection editor or answer-generation timeout.

## Acceptance Criteria

- Enabled Search integrations distinguish an active configuration from actual
  runtime readiness, and users cannot select hosted engines with no compatible
  available model.
- Search owns an administrator-configurable per-engine timeout measured in
  human-readable seconds, with a five-minute default, a bounded fifteen-minute
  maximum, and the same deadline honored by compatible provider transports.
- Providers shows configured connections immediately without exposing secrets
  or eagerly mounting the full connection editor; selecting a summary opens the
  exact connection.
- Focused and full checks pass, living contracts describe the behavior, and a
  new immutable release is deployed and smoke-tested on the operator-selected
  production installation.

## Tests

- Focused Search configuration, readiness, catalog, execution/transport,
  provider-summary service/decoder, component, and browser behavior checks.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.
- Release privacy/image checks and authenticated sanitized production smoke.

## Done Notes

- Search readiness now evaluates the immutable active revision together with
  its live provider/model dependencies. Current-user catalogs omit unavailable
  hosted options while client-engine compatibility remains independently
  validated.
- Search owns a validated 5-second-to-15-minute per-engine timeout, defaults new
  drafts to five minutes, renders the value in seconds/minutes, and passes the
  exact revision deadline through compatible provider transports.
- Provider Quick setup now returns and renders least-data configured-connection
  summaries with exact connection navigation and no endpoint, credential, or
  diagnostic material.
- Full development checks passed: 323 test files passed (2 skipped), 2,709
  tests passed (14 skipped), plus docs, lint, and TypeScript. The opt-in Prisma
  Quick setup suite passed 10/10, focused Playwright Search/Providers/Quick
  setup scenarios passed, and the non-root release image passed runtime smoke.
- Release `v0.1.9` was published as a multi-platform immutable image and deployed
  to the operator-selected installation after a verified backup. The two stale
  built-in Search entries were disabled; both generic client engines were
  tested and activated as revision 2 with five-minute deadlines.
- Final authenticated production smoke completed one aggregate two-engine
  invocation: both Search runs completed with eight sources each, exact
  revision/invocation evidence, and a complete answer run. Browser smoke at
  `1440x500` confirmed the Providers summaries, Search settings, reachable form
  bottom, and no horizontal overflow or browser errors.
