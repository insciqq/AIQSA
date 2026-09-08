# ENVIRONMENT

Owner: Configuration and deployment maintainers
Scope: Environment ownership, secret rotation, and Compose selection.

## Canonical Sources

[`.env.example`](../.env.example), [production Compose](../compose.yaml), [development Compose](../docker-compose.dev.yml), and subsystem parsers/tests own keys, defaults, validation, and ceilings. [Configure](../scripts/configure.sh) creates installation secrets once and refuses to replace an existing `.env`. Update parser, relevant Compose pass-through, examples, and tests for key changes; update prose only for a changed operator/security contract. Malformed security settings fail closed. Site-specific provisioning belongs to the infrastructure operator.

Mutable provider/Search credentials and configuration belong in encrypted database records, not general environment keys. Environment supplies installation wiring and bounded policy/recovery inputs. Each role receives only what it consumes: parsers have no database/object/provider credentials; Workspace runner has only its internal token and bounded runtime policy; maintenance has database/runner access without object/provider credentials; restore review has no provider credentials and cannot start ordinary work.

Test auth, fake providers, demo credentials, and deterministic runtime require the complete disposable non-production gates. They never authorize testing persistent operator data. Optional SMTP/OAuth/parser/Memory absence must not weaken core authentication or accidentally redefine core readiness. Emergency switches are temporary, auditable outside source control, and never bypass ownership, egress, migration, or retention guards.

## Secrets And Rotation

Keep `.env` restricted and outside Git, images, logs, transcripts, and support bundles. Local development uses explicit disposable defaults or the ignored local profile. Production provisioning/rotation belongs to the infrastructure operator.

Session/flow signing, `AIQSA_ENCRYPTION_KEY`, Memory fingerprint keyring, Memory OpenSearch routing key, and Workspace internal token have independent cryptographic purposes; never derive one from another. Back up required encryption/Memory keys separately from data.

Replacing `AIQSA_ENCRYPTION_KEY` without migration loses encrypted provider/SMTP/MCP/OAuth readability and changes ToolHive ownership markers: drain/clean exact owned workloads first. Fingerprint rotation is additive; missing historical versions block affected state, and backup preflight records required IDs without keys. Routing-key or ID rotation requires a full derived lexical rebuild before readiness; canonical PostgreSQL survives but mixed-key fallback is forbidden. Missing key history or destination consent never weakens suppression or selects another destination.

The trusted base URL determines callback/email origins, cookie/HSTS defaults, and same-origin policy; request Host/forwarding never selects it. Changing it is an identity/security migration. Loopback is the default bind, proxy trust requires the complete reviewed chain, and direct non-loopback HTTP requires immediate-peer proof and gives no confidentiality. [Security](SECURITY.md) owns exposure rules.

A browser-reachable S3 endpoint is an explicit optional boundary for the same private bucket, requiring application-origin CORS and multipart ETag exposure. Without it, bounded upload streaming stays through the app. Runner URL/token are required together; absent wiring leaves Workspace undeployed. Runtime/image/MCP identities are exact compatibility pins and configurable resource bounds cannot exceed parser-owned ceilings.

## Operations

Each checkout owns its ignored `.env` and selected private Compose overrides. Preserve project identity, ports, installation keys, and existing resource bindings when synchronizing code.

When `.env` defines `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, use ordinary `docker compose` from that checkout. Explicit `-f`, including package-script arguments, replaces that file selection; use it only for a deliberately selected topology. Changing `-p` does not isolate tests when overrides pin existing external volumes. Inspect selectors without printing private values and use separate disposable state for destructive checks. Stable volume names are not test isolation.

Memory lexical rollout/rollback/recovery procedures belong to infrastructure. PostgreSQL is the rollback default; shadow is observation only, while canary/primary retain canonical checks and bounded PostgreSQL fallback. Backend/percentage changes require app recreation; the projection worker is independent. Identity-write-profile activation requires content-free cutover preflight and retains exact legacy rollback. The coordinator lease is a replay-safety window, not a provider timeout: an undersized lease can mark a healthy call outcome-unknown, while a longer one delays crash recovery.

Never print resolved environment snapshots. Verification reports presence/validity booleans and stable issue codes only. See [Testing](TESTING.md) for disposable overrides and [Persistence](PERSISTENCE.md) for recovery.
