# ENVIRONMENT

Owner: Configuration and deployment maintainers
Scope: Environment ownership, security-sensitive categories, Compose wiring, and change rules.

## Canonical Sources

`.env.example` is the operator-facing inventory and starting template. `docker-compose.yml`, `docker-compose.dev.yml`, deployment assets, and the focused config parsers beside each subsystem own consumption, defaults, validation, reductions, and hard ceilings. Do not duplicate every key or numeric value here; inspect those sources and their tests when changing configuration.

A new or changed key updates its canonical parser, `.env.example`, relevant Compose/ops pass-through, focused tests, and this document only when it changes a durable operator/security contract. Canonical names replace pre-production aliases unless an external installation compatibility decision explicitly requires one. Unknown or malformed security-relevant values fail closed rather than silently enabling a weaker mode.

| Category | Durable contract |
| --- | --- |
| Installation identity/data | Database and private-object credentials, application base URL, and initial administrator inputs are required only by the roles that consume them. Bootstrap credentials create/adopt the first identity and are not runtime user configuration. |
| Cryptographic material | Session/flow signing, `AIQSA_ENCRYPTION_KEY`, and the Memory fingerprint keyring are independent random values with separate backup/rotation consequences. Never derive one from another. |
| Address/cookies/proxy | Loopback is the default bind. Cookie security follows the trusted base URL unless explicitly set. Proxy trust requires the complete reviewed chain; direct non-loopback mode requires immediate-peer proof and does not provide transport encryption. |
| Providers/Search | Credentials and mutable provider configuration live encrypted in the database, not general environment keys. Environment values bound response deadlines/bytes/events and emergency recovery only; code/admitted revisions own normal execution. |
| Memory | Coordinator capacity, leases, egress consent mode, and fingerprint key history are installation policy. Missing key history or destination consent pauses/fails affected work; it never selects a fallback or weakens suppression. |
| MCP | ToolHive/controller endpoints and bounded transport/runtime settings are private deployment wiring. OAuth/static/personal values live in encrypted records. Internal-network permission is per reviewed server, not a global SSRF bypass. |
| HTTP/auth/mail | Body, rate, SMTP, and auth-flow deadlines are bounded by focused parsers. OAuth and SMTP secrets are optional feature-local inputs; absence disables/degrades that feature without weakening core auth. |
| Uploads/parsers/runs | Upload, extraction, parser, attachment-materialization, and provider-response settings may reduce reviewed defaults within hard ceilings. Separate source, encoded, time, page/block, and response bounds remain independently enforced. |
| Compose resources | Image identities, volumes, CPU/memory/log budgets, parser endpoints, and private network wiring belong to Compose/ops. Stable persistent volume names are not test isolation. |
| Development/testing | Fake provider, deterministic auth, test mode, token delays, and Playwright fixtures require their complete non-production gates. Production ignores or rejects them; they never authorize testing an operator installation. |

## Secrets And Rotation

Keep `.env` mode-restricted and outside Git, images, logs, shell transcripts, and support bundles. `prepare-secrets.sh` creates a fresh file without reading/replacing an existing one and prints the generated initial password once; move that password to a manager and remove it from `.env` after bootstrap.

Changing `AIQSA_ENCRYPTION_KEY` without a planned migration makes encrypted provider, SMTP, MCP, and OAuth values unreadable and changes ToolHive ownership markers. Drain/clean exact owned ToolHive workloads before replacement. Losing a Memory fingerprint key blocks any state that references its version; the keyring supports additive rotation, and backup/restore preflight records required IDs without key material.

The trusted application base URL is the origin for OAuth callbacks, email links, cookie/HSTS defaults, and same-origin policy. Request Host/forwarding data never selects it. Treat a change as an identity and security migration, not cosmetic configuration.

## Operations

Runtime roles receive least configuration: app, Memory worker, migration/bootstrap, maintenance, parser, and restore/review do not share every secret. Parser siblings receive no database/object/provider credentials. Restore review receives no provider credentials and cannot start ordinary work.

Emergency recovery switches are narrow, temporary, auditable, and fail closed by default. They do not redefine supported topology or bypass migration, ownership, egress, or retention guards. Record their use outside source control and remove them after the exact recovery action.

Never print a resolved environment snapshot during verification. Evidence uses presence/validity booleans and stable issue codes only. Follow [Security](SECURITY.md) for trust consequences and [Testing](TESTING.md) for disposable overrides.
