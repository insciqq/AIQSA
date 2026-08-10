# SECURITY — DEPLOYMENT AND DEPENDENCIES

Owner: Security and privacy maintainers
Scope: Local test-auth isolation, Compose installation exposure, and dependency installation/audit boundaries.
Read when: Changing local auth fixtures, Compose exposure, deployment ports, dependency manifests, lifecycle scripts, or security audits.
Code owners: Test-auth owners, `docker-compose*.yml`, `ops/`, `package.json`, and dependency lockfiles.
Not owned here: Production auth/session semantics, MCP runtime trust, or private provider/upload inputs.

## Local Test Auth

The repeatable demo seed carries the public fixture credential `operator@aiqsa.local` / `AIQSA-local-2026!`. It runs only with exact internal `AIQSA_TEST_MODE=1` and non-production `NODE_ENV`, restores the credential on every development-stack startup/seed, and must never be used for an operator installation. The default release image's migration/bootstrap role uses operator-supplied initial credentials; it does not run the demo seed.

Deterministic auth is enabled only when `PLAYWRIGHT_TEST_AUTH=1`, `AIQSA_TEST_MODE=1`, and `NODE_ENV` is not `production`. `NODE_ENV=test` alone does not enable it, and the compiled runtime ignores the switch. The test-only auth-mail route returns `404` outside allowed test mode.

Local test authentication is authorized only inside the disposable verification
topology owned by [Testing](../TESTING.md). That bounded exception grants no
authority over the persistent installation or any operator-designated target.

Reusable-server browser tests must revoke only the exact session created by that test. They must not exercise a user-wide admin revocation against the shared seeded operator: other browser/operator sessions may legitimately coexist in the disposable development stack, and a routine unit-test run must never target that seeded identity for disable/revoke coverage.

Playwright pins the seeded local user, local app URL, and local MinIO endpoint and does not inject real provider/SMTP or bootstrap/auth secrets. The disposable database exposes only Fake QSA to its test users, so routine E2E cannot become an external provider run; local bucket credentials remain available only for the Compose test storage path.

## Compose Installation Exposure

The default `app` publishes on `${AIQSA_BIND_ADDRESS:-127.0.0.1}`; Postgres and MinIO have no host ports. Loopback HTTP needs no domain. A trusted LAN/VPN may use direct publication and immediate-peer admission, with a warning that HTTP is unencrypted. Internet or encrypted exposure keeps the app on loopback behind the SSE/upload-aware TLS proxy template.

The installation requires explicit session, PostgreSQL, MinIO, Memory suppression-keyring, and initial-admin inputs under canonical names. The unified release image uses a digest-pinned runtime base and runs as non-root. Its app, private no-API Memory worker, migration/bootstrap, and maintenance roles share filesystem contents but receive distinct Compose commands and role-specific environment; only the one-shot migration/bootstrap role runs committed `prisma migrate deploy` migrations and installation bootstrap. The worker receives only its database/keyring startup inputs in the feature-dark phase and is not an app-readiness dependency. After migrations, bootstrap makes its empty-versus-adopted decision before the legacy control-plane cutover can add rows. Bootstrap requires an explicit initial email and a password on a fresh database, refuses a nonempty unadopted target before mutation, creates no demo chat, and never rewrites adopted password/profile/settings/grant state.

The release pipeline, not an operator checkout, builds the companion Postgres image. Its builder starts from the same exact digest-pinned Postgres 16 Alpine image as the runtime, verifies the pinned pgvector source archive checksum before compilation, and leaves compilers and download tools out of the final image. Native amd64 and arm64 builds are combined only after the workflow verifies both platform digests and the resulting manifest. Compose may reference the companion only after publication, by immutable manifest digest. Any Postgres patch/base-digest or pgvector-version change requires a reviewed Dockerfile and source checksum update, both native builds, an extension load/cast smoke test, and a new manifest digest.

Services have resource/log bounds. Liveness is dependency-free; readiness fails closed for contradictory security configuration, unavailable Postgres/private S3, or missing required peer proof while accepting intentional direct HTTP. Its body stays generic and logs only deduplicated value-free codes; Memory worker/key-preflight failure remains feature-local. Before migrations, use the coordinated backup, which stops both writer roles and fences outstanding Memory leases before copying data. Restore verifies the bundle, accepts only acknowledged empty disposable targets, and blocks automatic Memory resume when its separately recovered keyring lacks any referenced ID.

## Dependency Safety

For a dependency change:

1. Review `package.json` and `package-lock.json`, including any new install-time lifecycle script and registry source.
2. Prefer `npm ci`; do not use broad or forced auto-upgrades.
3. Run:

```bash
npm run security:deps
```

This runs `npm audit --audit-level=high` and contacts the npm advisory endpoint with dependency metadata. The operator has approved this exact external check during dependency work. A confirmed high/critical vulnerability blocks the change until upgraded, removed, or documented as not applicable. If the sandbox blocks the network, rerun the same command with required escalation.

`shiki` is the reviewed runtime dependency for fenced-code highlighting. It is loaded lazily with a curated language/theme set. The code-highlighting sink injects HTML only from the local Shiki result; ordinary Markdown and unknown/streaming code remain React text. This contract and its hostile-code regression test own that trust boundary.

`katex` is the reviewed runtime dependency for assistant/public-share TeX math under this contract. It is bundled locally and loaded lazily. Untrusted expressions are length-capped, reject trust-required link/resource/HTML commands before loading KaTeX, and use `trust: false`, strict parse failure, bounded visual size and macro expansion, and no persistent macro object. Only a successful local KaTeX `renderToString` result enters the dedicated HTML sink; source text and errors stay escaped React text. Regression tests using the real KaTeX implementation must prove hostile link/resource/HTML commands emit no executable element or attribute.

`@modelcontextprotocol/sdk` is pinned exactly and is the sole MCP JSON-RPC, Streamable HTTP, session, notification, cancellation, and OAuth-protocol implementation. AIQSA imports its client/server transport subpaths behind narrow wrappers and does not expose the SDK's transitive Hono static-file server. Every remote MCP draft test and runtime request uses the dedicated safe fetch: production requires HTTPS, rejects URL credentials/fragments and any DNS result set containing a private or special-use address unless the administrator explicitly enabled that server's internal-network policy, pins an approved address at connection time, revalidates every bounded redirect, and preserves only content negotiation/content metadata across a cross-origin redirect. The pinned SDK must resolve `@hono/node-server` 2.0.10 or later because its union dependency range still admits the advisory-affected 1.x line.

The root `sharp` development dependency and override keep Next's optional native decoder plus the OCR verification fixture generator on the audited `0.35.3` release while Next 16.2.11 still declares `^0.34.5`. This deliberately crosses Next's published optional range and the breaking `sharp` 0.35 line. AIQSA imports `sharp` only from the host/development OCR fixture script, where it converts a repository-owned Chromium render into deterministic grayscale PNG, JPEG, and WebP evidence; the application runtime does not import it or `next/image`, exposes no Next image-optimizer route, and processes user uploads through its separate bounded pipeline. Keep the override only while a clean production build and the hermetic lane pass; re-evaluate it when Next accepts `sharp` 0.35 or before adding any runtime image-optimizer or user-controlled `sharp` path.

The root `nanoid` override keeps PostCSS's build-only identifier helper on patched `3.3.17`; earlier 3.x releases can spin indefinitely when an attacker-controlled zero size reaches `customAlphabet` or `customRandom`. AIQSA does not import Nano ID or either custom-generator API, and repository-owned CSS compilation supplies no user-controlled size, but retaining the patched compatible 3.x release keeps the transitive build chain clean. Re-evaluate the override when maintained PostCSS metadata resolves directly to `3.3.17` or later.

The root `postcss` override keeps Next, Tailwind, Autoprefixer, and the test build chain on audited `8.5.25` instead of Next 16.2.11's exact `8.4.31` dependency. This deliberately crosses an upstream exact contract. PostCSS processes only repository styles during build, never user/provider CSS; Gemini Suggestions reach the browser as a style-free projection with repository-owned presentation. Keep the override gated by a clean production build plus the hermetic style/component lane, and re-evaluate it when the maintained Next line carries an audited PostCSS range or before adding runtime CSS compilation.

There is deliberately no custom lockfile scanner, signature/OSV pipeline, local CI bootstrap, or aggregate security gate. Exposed-installation hardening still requires direct review and the task-specific checks named by the relevant security/deployment task.
