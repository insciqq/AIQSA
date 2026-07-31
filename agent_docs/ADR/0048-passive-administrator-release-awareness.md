# ADR 0048: Passive Administrator Release Awareness

Status: Accepted
Amends: 0025-clean-slate-research-chat-and-control-center, 0028-task-first-control-center-and-direct-provider-setup, 0035-single-release-image-and-github-distribution

## Context

ADR 0035 makes a successfully published SemVer GitHub Release the operator's
public release boundary, but a running installation has no passive indication
that such a release is newer than its packaged version. Operators must inspect
GitHub manually and can miss an update. Checking raw tags would advertise a
release whose image/workflow may not have completed, while querying GitHub from
every browser would duplicate traffic, expose the dependency to ordinary
users, and make validation inconsistent.

An update notice must not become an updater. Pulling an image, migrating,
restarting, backing up, or rolling back remains an explicit operator action
under the installation and deployment contracts.

## Decision

### Release source and comparison

The server checks only GitHub's public latest-release endpoint for the fixed
official `insciqq/AIQSA` repository. It accepts only a non-draft,
non-prerelease, published response with a bounded valid SemVer tag. The running
version comes from the packaged root `package.json`; SemVer precedence ignores
an optional leading `v` and build metadata and follows numeric/non-numeric
prerelease ordering. The release-notes URL is constructed under the same fixed
repository from the validated tag rather than trusting a response redirect or
administrator input.

No GitHub credential or new environment setting is used. The request has a
five-second deadline and a 1 MiB response ceiling, sends the public GitHub
media/API headers, retains only the ETag plus bounded version/date/URL facts,
and never persists or returns the raw release body. Redirects fail closed.

### Availability and authorization

`GET /api/admin/release` is a separate active-admin-only route. It rechecks the
current database user role/status before invoking GitHub, so anonymous,
ordinary, inactive, or stale sessions receive no release data. Keeping this
read outside the main Control Center dashboard means GitHub latency or failure
cannot block administration.

Each application process coalesces concurrent reads and caches a successful
result for six hours. Expired results revalidate with ETag. A failed refresh
serves the last successful facts and backs off for 15 minutes; an initial
failure returns and briefly caches an explicit unavailable state. Cache loss on
restart and one cache per process are accepted for the current single-host
topology. GitHub availability is feature-local and never affects liveness or
readiness.

### Presentation and action boundary

The Control Center header quietly shows the installed version after the
dashboard is available. Only a strictly newer stable release adds an
`Update available` disclosure. Expansion shows installed/latest versions,
publication date when present, and an external release-notes link. Current or
unavailable state creates no warning. Network/decoder failure is silent and
does not replace last-good dashboard content.

The notice performs no download, image pull, backup, migration, restart,
deployment, tag creation, or version mutation. Release execution remains an
explicit operator workflow.

## Rejected Alternatives

- **Compare Git tags.** A tag can precede successful public image/release
  publication and is not the accepted operator release boundary.
- **Call GitHub directly from each browser.** It duplicates checks, weakens the
  admin-only boundary, and cannot share conditional caching.
- **Add a GitHub token.** The public endpoint and low cached request rate do not
  justify another installation secret.
- **Include the check in `/api/admin`.** An optional external dependency must
  not delay or fail the primary Control Center resource.
- **Automatically update the installation.** Backup, migration, restart, and
  rollback authority cannot be inferred from viewing a notice.

## Consequences

- Administrators can discover a newer public AIQSA release without leaving the
  product.
- A process normally makes at most four successful latest-release checks per
  day, with ETag revalidation and failure backoff.
- Multi-process installations may perform one cached check per process; a
  shared cache is deferred until that topology is supported.
- GitHub failure removes only freshness information and cannot make the Control
  Center unavailable.

## Required Verification

- SemVer parsing/precedence, stable-release validation, fixed URL, no-auth
  request, ETag/cache/coalescing, stale-on-error, timeout, and failure backoff;
- anonymous/ordinary/inactive denial before the status reader runs;
- strict browser decoder and quiet controller failure;
- current versus newer header presentation, safe release link, and desktop/
  compact overflow checks; and
- routine static, unit, component, browser, and documentation checks.
