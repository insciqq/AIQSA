---
paths:
  - "app/api/**"
  - "lib/server/http/**"
  - "lib/server/admin/**"
  - "lib/server/assistants/**"
  - "lib/server/skills/**"
  - "lib/server/skillsMcp/**"
  - "lib/server/shares/**"
  - "lib/server/chats/**"
  - "lib/server/uploads/**"
---
# Backend

HTTP routes in `app/api/`, server modules in `lib/server/`, and the control planes for Assistants, Skills and MCP servers. Schema work also follows `agent_docs/PERSISTENCE.md`; sign-in and SCIM follow `agent_docs/SIGN_IN.md`.

## Routes

- A route authenticates, bounds and decodes input, calls its owner in `lib/server/`, and serializes an explicit projection. Reusable behavior lives below the route.
- Browser mutations pass the shared same-origin guard (`proxy.ts`, `lib/server/auth/csrf.ts`) and bounded body reading (`lib/server/http/requestBody.ts`).
- Errors are stable codes without raw exceptions or hints that a resource exists.

## Control planes

- Configuration changes use optimistic concurrency and validate atomically. Never silently clamp, substitute or partially apply a change that spans several resources.
- The Control Center attention list (`lib/server/admin/attention/`) only aggregates administrator projections that are already authorized. An unavailable source is named without failing the list, and entries carry human copy and links, never raw failures or private identifiers.
- Using an installation MCP server lets a member fill in its required personal values. Overriding a shared value replaces an installation credential and needs a direct per-user permission.
- Inbound MCP clients act as the current active account and cannot choose another owner. Memory calls and Hub dispatch create no synthetic chat, run or history.

## Assistants

- Publishing an Assistant grants live future use, not entitlement to its dependencies. Fixed rows and Skill links are dependencies; adjustable rows are starting values a chat may replace. Accepted runs keep the definition, effective rows and a snapshot of name and avatar. Ordinary chats use the server-owned baseline, which the browser cannot replace.
- Publication requires that every linked Skill has an approved revision and is directly available to the Assistant's audience. Unlinking or unpublishing clears dependent defaults, plans and authorities in one transaction.
- Non-administrators list an Assistant installation-wide only through an approved request, which covers the requested version only. Administrators read a private definition only through a pending request for its current version.

## Skills

- A write grant to the Skill store permits changes only, never sharing or execution. A package missing from a client's listing does not mean it was deleted.
- Every Skill write goes through `lib/server/skills/revisionWriteCore.ts`. Revisions are append-only: restoring makes an earlier revision current as a new revision, and the published revision never changes.
- A release ships Skills to every user (operator decisions 2026-11-06, `lib/server/skills/shippedSkills.ts`). The list is explicit, because `skills/` also holds Skills for coding agents. A shipped Skill has no owner, so no owner path edits, deletes or shares it, and it is on for each user until that user turns it off. Its access comes from `shippedKey`, never a publication, so the previous release, still serving during the upgrade, never sees an ownerless row; every copy of the audience rule (`skillAccessWhere`, the Assistant checks, the run binding SQL, the Automation pins) carries that branch. An administrator's installation-wide Off archives it, and upgrades never change that.
- Skill saves by the agent (`manage_skill`, operator decision 2026-10-07) follow the agent-initiated change rules in `agent_docs/RUN_CONTRACTS.md`, with the mitigations in `agent_docs/SECURITY.md`. Overwriting is guarded by the revision the run staged; a conflict writes nothing. Saving another user's Skill creates a personal copy. Code: `lib/server/tools/manageSkill.ts`, `lib/server/skills/agentSkills.ts`.

## Files, jobs and shares

- An upload becomes usable only after bounded type and content validation and server-side settlement of the stored object's integrity. Its status follows the exact ingestion artifact created for it, not another ready artifact.
- Long-running work runs as durable claimed jobs, and deletion as idempotent obligations, never as best effort inside a request.
- An opaque Workspace upload reaches execution only through an admitted run. File reads recheck the reader's current access, and storage authority never reaches browser or guest contracts. A PDF original stays available whether or not its extraction succeeds. A document or image the parser could not digest needs Workspace: a Workspace run takes its original and the model is told what did not reach it (`workspaceMissingContentNotice`); without Workspace admission refuses it, naming the limit and a recovery (operator request 2026-10-31).
- Chat exports (`aiqsa.chat` and `aiqsa.chat-archive`, `lib/contracts/chatExport.ts`) are held by users outside the installation. A published version never changes: a new shape bumps `version`, and import keeps accepting every published version. Exports contain export-local ids and readable text, never database ids, provider internals, usage or tool payloads.
- Anonymous shares (`lib/server/shares/`) are sanitized, immutable snapshots behind a hashed high-entropy bearer token, read and written through one allowlisted public schema. Private attachments, Memory and tool evidence, recovery state and private identifiers are dropped.
