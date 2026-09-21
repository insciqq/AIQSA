# ENVIRONMENT

Owner: Configuration and deployment maintainers
Scope: Environment ownership, secret rotation, and Compose selection.

## Canonical Sources

[Examples](../.env.example), [production](../compose.yaml)/[development Compose](../docker-compose.dev.yml), and subsystem parsers/tests own keys, defaults, validation and ceilings; update them together. [Configure](../scripts/configure.sh) creates secrets once, preserving existing `.env`. Prose owns operator/security contracts; malformed security settings fail closed. Infrastructure owns site provisioning.

Mutable provider/Search credentials/configuration belong in encrypted database records. Administrator-owned Agent limits default Off, independent of Workspace networking. Environment supplies installation wiring and bounded policy/recovery inputs. Roles receive only consumed authority: parsers no data/provider credentials; runner only its internal token/runtime policy; maintenance database/runner access without object/provider credentials; restore review no provider credentials or ordinary execution.

Artifact resource policy lives in [resourcePolicy](../lib/server/artifacts/resourcePolicy.ts). `AIQSA_ARTIFACT_EXTERNAL_RESOURCES=off` stops new downloads, preserving saved resources/local capabilities. `AIQSA_ARTIFACT_LIBRARY_HOSTS` and `AIQSA_ARTIFACT_IMAGE_HOSTS` replace defaults; empty means none. Adding npm mirrors or image hosts widens model-controlled URL egress, including bounded image queries; operators accept that disclosure risk.

Test auth/fakes/demo credentials/deterministic runtime require every disposable non-production gate, never persistent data. Optional SMTP/OAuth/parser/Memory absence cannot weaken auth/readiness. Emergency switches are temporary and externally auditable; ownership, egress, migration and retention guards remain mandatory.

## Secrets And Rotation

Keep `.env` restricted and outside Git, images, logs, transcripts, and support bundles. Local development uses explicit disposable defaults or the ignored local profile. Production provisioning/rotation belongs to the infrastructure operator.

Session/flow signing, `AIQSA_ENCRYPTION_KEY`, Memory fingerprint keyring, Memory OpenSearch routing key, and Workspace internal token have independent cryptographic purposes; never derive one from another. Back up required encryption/Memory keys separately from data.

Replacing `AIQSA_ENCRYPTION_KEY` without migration loses encrypted provider/SMTP/MCP/OAuth readability and changes ToolHive ownership markers: drain/clean exact owned workloads first. Fingerprint rotation is additive; missing historical versions block affected state, and backup preflight records required IDs without keys. Routing-key or ID rotation requires a full derived lexical rebuild before readiness; canonical PostgreSQL survives but mixed-key fallback is forbidden. Missing key history or destination authority never weakens suppression or selects another destination.

The trusted base URL determines callback/email origins, cookie/HSTS defaults, and same-origin policy; request Host/forwarding never selects it. Changing it is an identity/security migration. Loopback is the default bind, proxy trust requires the complete reviewed chain, and direct non-loopback HTTP requires immediate-peer proof and gives no confidentiality. [Security](SECURITY.md) owns exposure rules.

A browser-reachable S3 endpoint is an explicit optional boundary for the same private bucket, requiring application-origin CORS and multipart ETag exposure. Without it, bounded upload streaming stays through the app. Runner URL/token are required together; absent wiring leaves Workspace undeployed. Runtime/image/MCP identities are exact compatibility pins and configurable resource bounds cannot exceed parser-owned ceilings.

## Operations

Each checkout owns its ignored `.env` and selected private Compose overrides. Preserve project identity, ports, installation keys, and existing resource bindings when synchronizing code.

When `.env` defines `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, use ordinary `docker compose` from that checkout. Explicit `-f`, including package-script arguments, replaces that file selection; use it only for a deliberately selected topology. Changing `-p` does not isolate tests when overrides pin existing external volumes. Inspect selectors without printing private values and use separate disposable state for destructive checks. Stable volume names are not test isolation.

Memory lexical rollout/rollback/recovery procedures belong to infrastructure. PostgreSQL is the rollback default; shadow is observation only, while canary/primary retain canonical checks and bounded PostgreSQL fallback. Backend/percentage changes require app recreation; the projection worker is independent. The coordinator lease is a replay-safety window, not a provider timeout: an undersized lease can mark a healthy call outcome-unknown, while a longer one delays crash recovery.

Never print resolved environment snapshots. Verification reports presence/validity booleans and stable issue codes only. See [Testing](TESTING.md) for disposable overrides and [Persistence](PERSISTENCE.md) for recovery.
