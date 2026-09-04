# ENVIRONMENT

Owner: Configuration and deployment maintainers
Scope: Environment ownership, security-sensitive categories, Compose wiring, and change rules.

## Canonical Sources

`.env.example` is the operator-facing inventory and starting template. `docker-compose.yml`, `docker-compose.dev.yml`, deployment assets, and the focused config parsers beside each subsystem own consumption, defaults, validation, reductions, and hard ceilings. Do not duplicate every key or numeric value here; inspect those sources and their tests when changing configuration.

A new or changed key updates its canonical parser, `.env.example`, relevant Compose/ops pass-through, focused tests, and this document only when it changes a durable operator/security contract. Canonical names replace pre-production aliases unless an external installation compatibility decision explicitly requires one. Unknown or malformed security-relevant values fail closed rather than silently enabling a weaker mode.

| Category | Durable contract |
| --- | --- |
| Installation identity/data | Database and private-object credentials, application base URL, and initial administrator inputs are required only by the roles that consume them. Bootstrap credentials create/adopt the first identity and are not runtime user configuration. |
| Cryptographic material | Session/flow signing, `AIQSA_ENCRYPTION_KEY`, the Memory fingerprint keyring, and the Memory OpenSearch routing key are independent random values with separate backup/rotation consequences. Never derive one from another. |
| Address/cookies/proxy | Loopback is the default bind. Cookie security follows the trusted base URL unless explicitly set. Proxy trust requires the complete reviewed chain; direct non-loopback mode requires immediate-peer proof and does not provide transport encryption. |
| Providers/Search | Credentials and mutable provider configuration live encrypted in the database, not general environment keys. Environment values bound response deadlines/bytes/events and emergency recovery only; code/admitted revisions own normal execution. |
| Memory | Coordinator capacity, leases, bounded embedding/projection batches, egress consent mode, fingerprint key history, opaque OpenSearch routing identity, lexical backend rollout mode, and the versioned identity write profile are installation policy. `POSTGRES` is the rollback default; `SHADOW` adds only detached, bounded observations; `OPENSEARCH_CANARY` uses a stable HMAC-derived user cohort; and `OPENSEARCH` makes the derived index the normal lexical candidate source. Canary/primary failures retain PostgreSQL fallback behind a bounded Memory-only circuit breaker and never change canonical authority. Identity activation captures its profile in every source job and keeps an exact legacy rollback mode; change it only after the content-free identity cutover preflight. A routing-key ID is part of the lexical projection contract, so key rotation requires a full rebuild rather than mixed routing. Missing key history, routing material, or destination consent pauses/fails affected work; it never selects a fallback or weakens suppression. |
| MCP | ToolHive/controller endpoints and bounded transport/runtime settings are private deployment wiring. OAuth/static/personal values live in encrypted records. Internal-network permission is per reviewed server, not a global SSRF bypass. |
| Workspace | A blank runner URL and token leave the runtime undeployed; both are required together, and the capability is still enabled separately through administrator policy. The token is an independent internal-service secret. Runtime/MCP/image identities are exact compatibility pins; CPU, memory, disk, time, call/round, and output settings may vary only inside parser-owned hard ceilings. The host KVM group and dedicated runtime-volume identity are deployment inputs. Deterministic runtime is test-only and fails closed outside the complete disposable test gate. |
| HTTP/auth/mail | Body, rate, SMTP, and auth-flow deadlines are bounded by focused parsers. OAuth and SMTP secrets are optional feature-local inputs; absence disables/degrades that feature without weakening core auth. |
| Uploads/parsers/runs | Upload, batch-count, extraction, parser, attachment-materialization, and provider-response settings may reduce reviewed defaults within hard ceilings. Separate source, encoded, time, page/block, and response bounds remain independently enforced. A browser-reachable S3 endpoint is an explicit optional trust boundary for the same private bucket; absence keeps bounded streaming through the app, while enabling it requires application-origin CORS and exposed multipart ETag headers. |
| Compose resources | Image identities, volumes, CPU/memory/log budgets, parser endpoints, and private network wiring belong to Compose/ops. PostgreSQL 18 uses its versioned volume root. OpenSearch is fixed internal deployment wiring on a dedicated control network; its Knowledge and Personal Memory projections are derived and rebuildable, never a backup authority or browser endpoint. Stable persistent volume names are not test isolation. |
| Development/testing | Fake provider, deterministic auth, test mode, token delays, and Playwright fixtures require their complete non-production gates. Production ignores or rejects them; they never authorize testing an operator installation. |

## Secrets And Rotation

Keep `.env` mode-restricted and outside Git, images, logs, shell transcripts, and support bundles. `prepare-secrets.sh` creates a fresh file without reading/replacing an existing one and prints the generated initial password once; move that password to a manager and remove it from `.env` after bootstrap.

Changing `AIQSA_ENCRYPTION_KEY` without a planned migration makes encrypted provider, SMTP, MCP, and OAuth values unreadable and changes ToolHive ownership markers. Drain/clean exact owned ToolHive workloads before replacement. Losing a Memory fingerprint key blocks any state that references its version; the keyring supports additive rotation, and backup/restore preflight records required IDs without key material. Losing the independent Memory OpenSearch routing key does not lose canonical PostgreSQL data, but the derived lexical index must be rebuilt under a new key and identifier before it can become ready again.

The trusted application base URL is the origin for OAuth callbacks, email links, cookie/HSTS defaults, and same-origin policy. Request Host/forwarding data never selects it. Treat a change as an identity and security migration, not cosmetic configuration.

## Operations

Runtime roles receive least configuration: app, Memory worker, migration/bootstrap, maintenance, parser, Workspace runner, and restore/review do not share every secret. Parser siblings receive no database/object/provider credentials. The Workspace runner receives only its internal token and bounded runtime/image policy; the maintenance role receives database and runner access but no object/provider credentials. Restore review receives no provider credentials and cannot start ordinary work.

Emergency recovery switches are narrow, temporary, auditable, and fail closed by default. They do not redefine supported topology or bypass migration, ownership, egress, or retention guards. Record their use outside source control and remove them after the exact recovery action.

The [Memory OpenSearch runbook](../ops/opensearch/README.md) owns rollout, immediate rollback, circuit recovery, projection rebuild, restore, purge verification, routing-key rotation, and content-free alert procedures. Backend or percentage changes take effect only after the app role is recreated; the projection worker is independent and may continue accumulating or draining derived work while reads are forced to PostgreSQL.

The Memory coordinator lease is a replay-safety window, not a provider timeout. A longer bounded lease delays crash recovery; a lease shorter than the runtime's heartbeat/provider window can force an otherwise healthy external call into `OUTCOME_UNKNOWN`. Development Compose therefore tolerates compiler pauses while production keeps the independently heartbeated worker default unless an operator deliberately changes it.

Never print a resolved environment snapshot during verification. Evidence uses presence/validity booleans and stable issue codes only. Follow [Security](SECURITY.md) for trust consequences and [Testing](TESTING.md) for disposable overrides.
