# ADR 0029: Built-in Full Access Group

Status: Accepted
Amends: 0021-admin-managed-mcp-tools-and-isolated-runtime, 0022-admin-managed-llm-provider-control-plane, 0028-task-first-control-center-and-direct-provider-setup

## Context

An installation needs one explicit administrator-controlled membership that means “all product resources” without requiring an operator to revisit the group after every provider connection, model, search strategy, or MCP server is added. Ordinary explicit grants cannot express this safely: they cover only resources that already exist, drift as the installation grows, and provider-wide rows can become deletion blockers for resources that should still be removable.

The group must not become an implicit role or a shortcut around secret selection. Provider/model entitlement and provider credential resolution are intentionally independent, and MCP personal secret slots are direct-user permissions. Automatically placing every approved or invited user into an all-powerful group would also defeat the existing approval/default-group boundary.

## Decision

### System identity and lifecycle

There is exactly one built-in group with `Group.systemRole = full_access` and the display name `Full access`. Ordinary groups have no system role. The database uniqueness constraint permits at most one row for that role.

The built-in group is installation state, not an administrator-created policy row. It cannot be renamed, archived, deleted, or have its wildcard access disabled through ordinary group-grant APIs. Its membership remains explicit and administrator-managed. New users are not added automatically.

The initial installation administrator is a member with owner membership. Fresh bootstrap creates or repairs the group and membership; adopted bootstrap repairs them idempotently. The migration for existing installations creates the group and adds the earliest extant administrator ordered by creation time and id. An existing ordinary group whose trimmed case-insensitive name collides with the reserved `Full access` identity is never promoted: it is renamed to the first free `Full access (custom)` suffix while retaining its id, archived state, members, grants, credential assignments, invite/rule references, and ordinary semantics. The isolated system group is then created with only the initial administrator. Development seed keeps its existing fixture groups but also repairs the operator membership.

### Provider, model, and search access

An active user who belongs to the non-archived `full_access` group has entitlement to every current and future provider connection, provider model, and enabled search strategy. This is a semantic wildcard evaluated by catalog projection, administrator summaries, Quick-setup preservation, and transactional run admission. It is not materialized as ordinary `AccessGrant` rows, so it cannot create provider deletion blockers or drift when resources are added.

The wildcard does not select or reveal a provider credential. Credential resolution remains direct user, then one unambiguous active-group assignment, then an allowed connection default. A member may therefore be entitled to a model while the model remains unavailable until a usable credential and exact current availability check exist. A selected unusable credential still fails closed.

### MCP access

Members can use every current and future non-deleted MCP server through the existing grant-backed MCP runtime boundary. The migration backfills one `canUse = true` group grant for every existing server, and a database insert trigger creates the same grant whenever a future server is inserted. The generated rows are protected from ordinary grant mutation and follow server deletion through the existing cascade.

The generated MCP grant contains no personal slot keys. Personal static values and user OAuth identity remain user-owned setup and direct permission; membership never reveals, copies, or invents a secret. A server that requires missing personal configuration may therefore be visible but not ready until the member completes that setup.

### Presentation

`Access & groups` shows `Full access` as a built-in system group with a factual “all current and future resources” summary. Its Members task remains editable. Lifecycle and model/search/MCP grant toggles are replaced by read-only explanation rather than controls that the server would reject.

## Consequences

- The first administrator can use new entitled resources without maintaining a growing grant matrix, subject to the independent credential/readiness rules.
- Explicit ordinary groups continue to use exact provider/model/search/MCP grants and keep their existing lifecycle.
- The reserved system identity cannot silently elevate a legacy same-name group or its current/future members.
- Removing a user from `Full access` immediately removes the wildcard on future catalog and run-admission reads; it does not delete their direct grants, provider assignment, MCP personal values, or accepted-run evidence.
- Database and service guards make the system-group lifecycle fail closed even if a stale client renders an old action.
- The group is not an authorization role for Control Center access: administrator role checks remain separate.
