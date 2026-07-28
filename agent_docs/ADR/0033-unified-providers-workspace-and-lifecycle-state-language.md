# ADR 0033: Unified Providers Workspace And Lifecycle-State Language

Status: Accepted
Amends: 0021-admin-managed-mcp-tools-and-isolated-runtime, 0025-clean-slate-research-chat-and-control-center, 0026-personal-provider-quick-setup, 0028-task-first-control-center-and-direct-provider-setup, 0032-direct-custom-openai-compatible-setup

Amendment note: ADR 0039 renames the visible **Setup** task to **Quick setup** and presents Custom as its fifth equal provider choice while retaining this record's lazy task ownership, isolated Custom page, and lifecycle-state language.

## Context

Provider setup and the complete provider control plane were presented as two different pages: Quick setup was the default page, while a small **Advanced configuration** link opened another page that repeated Providers navigation and then introduced its own Connections and Run profiles tabs. That split hid important management work, made the contextual handoff easy to miss, and described ordinary connection/model/key lifecycle work as a special mode.

Lifecycle state also lacked one reliable visual meaning across the product. Enabled resources were often positive, but Disabled frequently fell back to the same muted text used for secondary copy. Operators could not scan whether a provider, model, credential, user, MCP server, email channel, access rule, or run profile was available, and an **Enable** action could look identical to low-priority utilities. In ordinary-user MCP Settings, one button also tried to communicate both current availability and the opposite lifecycle action; OAuth and missing-setup branches could hide the current Disabled fact entirely.

## Decision

`Control Center -> Providers` is one workspace with a persistent task line in this fixed order: **Setup**, **Connections**, **Run profiles**. Setup remains the default and shortest path. Its reviewed-provider sequence remains provider -> write-only key -> **Test & Save**, and Custom endpoint remains a Setup subtask. Connections owns the complete provider lifecycle; Run profiles remains a peer task. There is no separate Advanced Providers page, duplicate Advanced header, or Back-to-quick navigation.

The tasks keep separate lazy data owners. Opening Setup loads only the actor-relative Quick projection or the selected Custom task. Opening Connections loads the provider control-plane projection. Opening Run profiles loads only the run-profile projection. Contextual **Manage _provider_ connection** actions switch to Connections and resolve the exact created connection or the canonical/unambiguous selected family. Generic task switching does not invent a contextual selection. Leaving a Setup task clears its write-only browser secret. Switching between an already mounted Connections task and Run profiles may preserve local task state; returning to Setup releases that management subtree and its drafts.

The product uses one lifecycle-state language for resources that actually expose an enabled runtime flag, whether the scan point is in the Control Center or ordinary-user Settings:

- **Enabled** is an explicit positive status;
- **Disabled** is an explicit high-contrast neutral status, never muted secondary copy, a warning, or an unavailable HTML-control style;
- **Enable** is a visibly accented restoration action that remains secondary to the page's primary Save/Test/Activate action; and
- **Disable** remains a legible quiet action because it removes availability rather than advancing the current task.

The availability status is shown once per resource where a user scans or edits that resource. Status and action are separate elements: the current fact says **Enabled** or **Disabled**, while the control says **Enable**, **Disable**, or the truthful prerequisite action such as **Complete setup** or **Connect to enable**. Ordinary-user MCP Settings follows that rule, and its composer entry renders a visible aggregate availability fact while retaining readiness/tool detail in its title. Publication, draft, validation, readiness, grant, invitation, approval, archived, and ordinary disabled-form-control states retain their own semantics; they are not recast as lifecycle availability or multiplied into a badge dashboard.

## Consequences

- A first administrator still reaches a usable provider through one key form, while complete configuration is visible as a peer destination instead of a hidden mode.
- Connections, Credentials, Models, Authentication, Diagnostics, and Run profiles retain their existing server contracts and consequences; this decision changes presentation and client ownership boundaries, not provider persistence or authorization.
- The Quick and Custom APIs remain atomic simple-path orchestrators, and the provider control plane remains their persisted source of truth.
- Enabled/Disabled becomes consistently scannable in administration and ordinary-user MCP surfaces without assigning error color to an intentional off state or weakening the visual priority of **Test & Save**, Save, and Activate.

## Required Verification

Automated and browser evidence must prove the three persistent provider tasks, lazy resource loading, write-only secret clearing, exact/canonical contextual handoff, preserved connection lifecycle operations, and usable compact layout without page overflow. Focused component and MCP browser evidence must also cover the shared Enabled/Disabled presentation, separate availability status and lifecycle action, visible composer aggregate, and accented Enable versus quiet Disable actions on representative resources.
