# SECURITY

Owner: Security and privacy maintainers
Scope: Non-normative router to bounded security and privacy contract owners.

This file is a routing index, not a security contract owner. Read the mandatory cross-cutting invariants first, then only the affected security leaf.

| Read when | Contract owner |
| --- | --- |
| HTTP headers, origins, cookies, proxy trust, passwords, sessions, OAuth, auth admission, recovery, or enumeration resistance | [HTTP and auth](security/HTTP_AND_AUTH.md) |
| Local test auth, Compose exposure, deployment ports, dependency installation, lifecycle scripts, or audits | [Deployment and dependencies](security/DEPLOYMENT_AND_DEPENDENCIES.md) |
| MCP OAuth, source trust, local workloads, ToolHive lifecycle, runtime cleanup, grants, tokens, or tool evidence | [MCP runtime trust](security/MCP_RUNTIME.md) |
| Uploads, attachments, object storage, extraction, provider discovery, catalogs, or provider-controlled input | [Uploads and provider trust](security/UPLOADS_AND_PROVIDER_TRUST.md) |

Non-negotiable safety boundaries remain in [critical invariants](CRITICAL_INVARIANTS.md). Observable authentication and upload/share transitions are routed through [backend API and auth](backend/API_AND_AUTH.md), persistence rules through [persistence and retention](backend/PERSISTENCE_AND_RETENTION.md), and verification permissions through [testing](TESTING.md).
