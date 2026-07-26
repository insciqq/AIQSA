"use client";

import {
  activeInventory,
  diffMcpToolInventory,
  draftInventory,
  sourceDisplay
} from "@/components/admin/adminMcpDraft";
import {
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminMcpTask } from "@/components/admin/useAdminMcpSectionState";
import type {
  AdminMcpServer,
  McpConfigurationSlot,
  McpSlotValue,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import {
  Braces,
  ChevronRight,
  ExternalLink,
  FileClock,
  Gauge,
  Pencil,
  RotateCcw,
  ShieldAlert,
  TestTube2,
  Trash2,
  Wrench
} from "lucide-react";
import { useState } from "react";

const fieldLabel = "text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-[11px] leading-4 text-ink-muted";

const tasks: ReadonlyArray<{
  description: string;
  icon: typeof Gauge;
  id: AdminMcpTask;
  label: string;
}> = [
  { description: "Publication and trust", icon: Gauge, id: "overview", label: "Overview" },
  { description: "Source, auth, and fields", icon: Braces, id: "definition", label: "Definition" },
  { description: "Evidence and tool changes", icon: TestTube2, id: "validation", label: "Validate & tools" },
  { description: "Rollback and rebuild", icon: FileClock, id: "revisions", label: "Revisions" },
  { description: "Availability to users", icon: Wrench, id: "runtime", label: "Runtime" },
  { description: "Irreversible removal", icon: Trash2, id: "danger", label: "Delete" }
];

function testedRevisionIsActive(server: AdminMcpServer): boolean {
  return Boolean(
    server.draftTested &&
    server.activeRevision &&
    server.draftTest &&
    server.draftTest.identityHash === server.activeRevision.identityHash
  );
}

function publicationState(server: AdminMcpServer): { detail: string; label: string; tone: string } {
  if (server.draftTested && testedRevisionIsActive(server)) {
    return {
      detail: `Revision ${server.activeRevision?.revisionNumber ?? "—"} matches the latest tested identity.`,
      label: "Active revision tested",
      tone: "text-positive"
    };
  }
  if (server.draftTested) {
    return {
      detail: server.activeRevision
        ? "The tested identity differs from the active revision."
        : "The first tested revision is ready to activate.",
      label: "Tested · ready to activate",
      tone: "text-proof"
    };
  }
  if (server.activeRevision) {
    return {
      detail: "The active revision is unchanged; the mutable draft needs a new test.",
      label: "Draft changes need test",
      tone: "text-caution"
    };
  }
  return {
    detail: "No revision has been activated yet.",
    label: "No active revision",
    tone: "text-ink-muted"
  };
}

function oauthState(server: AdminMcpServer): { detail: string; label: string; tone: string } {
  if (server.draft.auth.mode !== "oauth") {
    return { detail: "This draft does not use OAuth.", label: "Not required", tone: "text-ink-muted" };
  }
  const connection = server.validationOAuth;
  if (connection?.state === "ready") {
    return {
      detail: connection.accountLabel ? `Validation account: ${connection.accountLabel}` : "Admin validation identity connected.",
      label: "Connected",
      tone: "text-positive"
    };
  }
  if (connection?.state === "reauthorization_required") {
    return { detail: "Reconnect the admin validation identity.", label: "Reauthorization required", tone: "text-caution" };
  }
  if (connection?.state === "disconnecting") {
    return { detail: "Existing validation credentials are being retired.", label: "Disconnecting", tone: "text-caution" };
  }
  return { detail: "Connect an admin-owned identity before validation.", label: "Not connected", tone: "text-ink-muted" };
}

function Fact({ detail, label, tone, value }: Readonly<{
  detail: string;
  label: string;
  tone: string;
  value: string;
}>) {
  return (
    <div className="min-w-0 border-l border-trace-strong pl-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-muted">{label}</dt>
      <dd className={`mt-1 break-words text-sm font-medium [overflow-wrap:anywhere] ${tone}`}>{value}</dd>
      <dd className="mt-1 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">{detail}</dd>
    </div>
  );
}

function slotInputValue(slot: McpConfigurationSlot, raw: string): McpSlotValue {
  if (slot.valueType === "number") return Number(raw);
  if (slot.valueType === "boolean") return raw === "true";
  return raw;
}

function oneTimeRequest(server: AdminMcpServer, values: Record<string, string>): Record<string, McpSlotValue> {
  const slots = new Map(server.draft.slots.map((slot) => [slot.slotKey, slot]));
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== "")
      .flatMap(([slotKey, value]) => {
        const slot = slots.get(slotKey);
        return slot ? [[slotKey, slotInputValue(slot, value)] as const] : [];
      })
  );
}

function OneTimeValues({
  disabled,
  onChange,
  server,
  values
}: Readonly<{
  disabled: boolean;
  onChange(slotKey: string, value: string): void;
  server: AdminMcpServer;
  values: Record<string, string>;
}>) {
  const candidates = server.draft.slots.filter((slot) =>
    slot.policy.kind === "personal" ||
    (slot.policy.kind === "shared" && !server.sharedValues[slot.slotKey]?.configured)
  );
  if (!candidates.length) return null;
  return (
    <div className="grid gap-3 border-l border-trace-strong bg-workspace-rail/45 px-3 py-3">
      <div>
        <h5 className="text-xs font-medium text-ink-secondary">One-time validation values</h5>
        <p className={helpText}>Sent only with the next request. They are never saved as shared or personal configuration and are cleared when the request settles.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {candidates.map((slot) => (
          <label className="min-w-0" key={slot.slotKey}>
            <span className={fieldLabel}>{slot.label}</span>
            {slot.valueType === "boolean" ? (
              <select
                className={`${inputClass} mt-1.5`}
                disabled={disabled}
                onChange={(event) => onChange(slot.slotKey, event.currentTarget.value)}
                value={values[slot.slotKey] ?? ""}
              >
                <option value="">Select a value</option>
                <option value="false">False</option>
                <option value="true">True</option>
              </select>
            ) : slot.valueType === "enum" ? (
              <select
                className={`${inputClass} mt-1.5`}
                disabled={disabled}
                onChange={(event) => onChange(slot.slotKey, event.currentTarget.value)}
                value={values[slot.slotKey] ?? ""}
              >
                <option value="">Select a value</option>
                {(slot.enumValues ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ) : (
              <input
                autoComplete="new-password"
                className={`${inputClass} mt-1.5`}
                disabled={disabled}
                onChange={(event) => onChange(slot.slotKey, event.currentTarget.value)}
                type={slot.sensitive ? "password" : slot.valueType === "number" ? "number" : "text"}
                value={values[slot.slotKey] ?? ""}
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

function InventoryList({ empty, tools }: Readonly<{
  empty: string;
  tools: readonly McpToolInventoryEntry[];
}>) {
  if (!tools.length) return <p className="py-3 text-xs text-ink-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-trace-subtle border-y border-trace-subtle">
      {tools.map((tool) => (
        <li className="min-w-0 py-3" key={tool.name}>
          <div className="break-words font-mono text-xs font-medium text-ink [overflow-wrap:anywhere]">{tool.name}</div>
          {tool.description ? <p className="mt-1 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">{tool.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function OAuthValidation({ controller, server }: Readonly<{
  controller: AdminMcpController;
  server: AdminMcpServer;
}>) {
  if (server.draft.auth.mode !== "oauth") return null;
  const encoded = encodeURIComponent(server.id);
  const connection = server.validationOAuth;
  const archived = Boolean(server.archivedAt);
  const ready = connection?.state === "ready";
  const needsReconnect = connection?.state === "reauthorization_required";
  const disconnecting = connection?.state === "disconnecting";
  return (
    <section className="border-b border-trace-subtle pb-5">
      <h4 className="text-sm font-semibold text-ink">Validation OAuth identity</h4>
      <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">This administrator-owned identity validates the installation draft only. Users authorize their own identities separately.</p>
      <div className={`mt-3 border-l-2 px-3 py-2 text-xs leading-5 ${ready ? "border-positive bg-positive/10 text-positive" : needsReconnect ? "border-caution bg-caution/10 text-caution" : "border-trace-strong bg-workspace-rail/45 text-ink-secondary"}`}>
        <div>{ready ? "Connected" : needsReconnect ? "Reauthorization required" : disconnecting ? "Disconnecting" : "Not connected"}</div>
        {connection?.accountLabel ? <div className="mt-1 break-words text-[11px] [overflow-wrap:anywhere]">External account: {connection.accountLabel}</div> : null}
        {connection?.connectedAt ? <div className="mt-1 text-[11px] opacity-80">Last connected {new Date(connection.connectedAt).toLocaleString()}</div> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <form action={`/api/admin/mcp/${encoded}/oauth/validation/connect`} method="post">
          <button className={ready ? quietButton : primaryButton} disabled={archived} type="submit">
            {ready ? "Check connection" : "Connect"}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </button>
        </form>
        <form action={`/api/admin/mcp/${encoded}/oauth/validation/reconnect`} method="post">
          <button className={quietButton} disabled={archived} type="submit">
            Reconnect
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </button>
        </form>
        <button
          className={quietButton}
          disabled={archived || controller.state.busy || !connection || connection.state === "disconnected" || disconnecting}
          onClick={() => void controller.actions.disconnectValidationOAuth(server.id)}
          type="button"
        >
          Disconnect
        </button>
      </div>
    </section>
  );
}

function OverviewTask({ controller, onOpenTask, server }: Readonly<{
  controller: AdminMcpController;
  onOpenTask(task: AdminMcpTask): void;
  server: AdminMcpServer;
}>) {
  const publication = publicationState(server);
  const oauth = oauthState(server);
  const activeMatch = testedRevisionIsActive(server);
  const activationAvailable = server.draftTested && !activeMatch;
  const archived = Boolean(server.archivedAt);
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Fact
          detail={archived ? "Legacy record is retained as read-only evidence." : "Controls whether the active revision is offered to entitled users."}
          label="Availability"
          tone={archived ? "text-critical" : server.enabled ? "text-positive" : "text-caution"}
          value={archived ? "Legacy archived" : server.enabled ? "Enabled" : "Disabled"}
        />
        <Fact detail={publication.detail} label="Publication" tone={publication.tone} value={publication.label} />
        <Fact detail={oauth.detail} label="Validation identity" tone={oauth.tone} value={oauth.label} />
      </div>

      <section className="border-l-2 border-caution bg-caution/10 px-4 py-3 text-xs leading-5 text-caution">
        <div className="flex items-start gap-2">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>Activation trusts this server as one unit. The model may invoke every current or future valid tool it exposes, including state-changing tools. Local workloads also have unrestricted outbound network access and can observe Docker metadata available inside the runtime boundary.</p>
        </div>
      </section>

      <section>
        <h4 className="text-sm font-semibold text-ink">Next publication step</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">
          {archived
            ? "This legacy archived record is read-only."
            : activationAvailable
              ? "Review the tested inventory, then activate this exact identity. The current active revision remains unchanged until activation."
              : activeMatch
                ? "The latest tested identity is already active."
                : "Validate the unchanged current draft before activation."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {activationAvailable ? (
            <button className={primaryButton} disabled={controller.state.busy || archived} onClick={() => void controller.actions.activate(server.id)} type="button">
              Activate tested revision
            </button>
          ) : !activeMatch && !archived ? (
            <button className={primaryButton} onClick={() => onOpenTask("validation")} type="button">Validate draft</button>
          ) : null}
          <button className={quietButton} onClick={() => onOpenTask("definition")} type="button">Review definition</button>
        </div>
      </section>

      <section className="border-t border-trace-subtle pt-4">
        <h4 className="text-sm font-semibold text-ink">Installation evidence</h4>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div><dt className="text-ink-muted">Active revision</dt><dd className="mt-1 text-ink">{server.activeRevision ? `Revision ${server.activeRevision.revisionNumber}` : "None"}</dd></div>
          <div><dt className="text-ink-muted">Draft evidence</dt><dd className="mt-1 text-ink">{server.draftTested ? "Current and tested" : "Not tested or changed"}</dd></div>
          <div><dt className="text-ink-muted">Runtime evidence</dt><dd className="mt-1 text-ink">User-scoped; not returned by this admin catalog</dd></div>
        </dl>
      </section>
    </div>
  );
}

function DefinitionTask({ controller, onEdit, server }: Readonly<{
  controller: AdminMcpController;
  onEdit(): void;
  server: AdminMcpServer;
}>) {
  const auth = server.draft.auth.mode === "oauth"
    ? `OAuth · ${server.draft.auth.scopes.length} scope${server.draft.auth.scopes.length === 1 ? "" : "s"}`
    : server.draft.auth.mode === "static"
      ? "Static configuration"
      : "No protocol authentication";
  return (
    <div className="grid gap-6">
      <section>
        <h4 className="text-sm font-semibold text-ink">Current mutable draft</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Editing invalidates prior draft-test evidence. The active revision keeps running until another exact tested identity is activated.</p>
        <dl className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle text-xs">
          <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-muted">Source</dt><dd className="break-words font-mono text-ink [overflow-wrap:anywhere]">{sourceDisplay(server.draft.source)}</dd></div>
          <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-muted">Transport</dt><dd className="text-ink">{server.draft.transport === "streamable_http" ? "Streamable HTTP" : "stdio"}</dd></div>
          <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-muted">Authentication</dt><dd className="text-ink">{auth}</dd></div>
          <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-muted">Configuration fields</dt><dd className="text-ink">{server.draft.slots.length}</dd></div>
          <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-muted">Timeouts</dt><dd className="text-ink">Startup {server.draft.runtime.startupTimeoutMs} ms · call {server.draft.runtime.callTimeoutMs} ms</dd></div>
        </dl>
        <button className={`${primaryButton} mt-4`} disabled={controller.state.busy || Boolean(server.archivedAt)} onClick={onEdit} type="button">
          <Pencil aria-hidden="true" className="size-3.5" />
          Edit draft
        </button>
      </section>
      {server.draft.source.kind !== "remote" ? (
        <section className="border-l-2 border-caution bg-caution/10 px-4 py-3 text-xs leading-5 text-caution">
          Local MCP workloads run inside the trusted installation boundary with unrestricted outbound network access. Docker runtime metadata is visible to those workloads.
        </section>
      ) : null}
    </div>
  );
}

function ValidationTask({
  controller,
  oneTimeValues,
  server,
  setOneTimeValues
}: Readonly<{
  controller: AdminMcpController;
  oneTimeValues: Record<string, string>;
  server: AdminMcpServer;
  setOneTimeValues(values: Record<string, string>): void;
}>) {
  const active = activeInventory(server);
  const candidate = server.draftTested ? draftInventory(server) : [];
  const staleEvidence = !server.draftTested && Boolean(server.draftTest);
  const diff = diffMcpToolInventory(active, candidate);
  const values = oneTimeRequest(server, oneTimeValues);
  const busy = controller.state.busy || Boolean(server.archivedAt);
  const run = async (operation: "check" | "test") => {
    try {
      if (operation === "test") {
        await controller.actions.test(server.id, { oneTimeValues: values });
      } else {
        await controller.actions.checkUpdate(server.id, { oneTimeValues: values });
      }
    } finally {
      setOneTimeValues({});
    }
  };
  return (
    <div className="grid gap-6">
      <OAuthValidation controller={controller} server={server} />
      <section>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-ink">Exact draft validation</h4>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Test connects to the exact draft, discovers its complete tool inventory, and records the evidence required for activation.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={primaryButton} disabled={busy} onClick={() => void run("test")} type="button">
              <TestTube2 aria-hidden="true" className="size-3.5" />
              Test draft
            </button>
            <button className={quietButton} disabled={busy} onClick={() => void run("check")} type="button">
              <Wrench aria-hidden="true" className="size-3.5" />
              Check for update
            </button>
          </div>
        </div>
        <div className="mt-4">
          <OneTimeValues
            disabled={controller.state.busy}
            onChange={(slotKey, value) => setOneTimeValues({ ...oneTimeValues, [slotKey]: value })}
            server={server}
            values={oneTimeValues}
          />
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-ink">Tested draft tools</h4>
            <span className="font-mono text-[11px] text-ink-muted">{candidate.length}</span>
          </div>
          <InventoryList
            empty={staleEvidence
              ? "Previous test evidence belongs to an older draft and is not shown as current inventory. Test this draft again."
              : server.draftTested
                ? "The tested server exposed no tools."
                : "Test the current draft to discover tools."}
            tools={candidate}
          />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-ink">Change from active revision</h4>
            <span className="text-[11px] text-ink-muted">+{diff.added.length} added · {diff.changed.length} changed · −{diff.removed.length} removed</span>
          </div>
          {!server.draftTest ? (
            <p className="py-3 text-xs text-ink-muted">A diff appears after the current draft passes validation.</p>
          ) : (
            <div className="grid gap-2 border-y border-trace-subtle py-3 text-xs">
              {diff.added.length ? <p className="break-words text-positive [overflow-wrap:anywhere]">Added: {diff.added.map((tool) => tool.name).join(", ")}</p> : null}
              {diff.changed.length ? <p className="break-words text-caution [overflow-wrap:anywhere]">Changed: {diff.changed.map((tool) => tool.name).join(", ")}</p> : null}
              {diff.removed.length ? <p className="break-words text-critical [overflow-wrap:anywhere]">Removed: {diff.removed.map((tool) => tool.name).join(", ")}</p> : null}
              {!diff.added.length && !diff.changed.length && !diff.removed.length ? <p className="text-ink-muted">No tool changes from the active revision.</p> : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RevisionsTask({
  controller,
  oneTimeValues,
  rebuildRevisionId,
  server,
  setOneTimeValues,
  setRebuildRevisionId
}: Readonly<{
  controller: AdminMcpController;
  oneTimeValues: Record<string, string>;
  rebuildRevisionId: string | null;
  server: AdminMcpServer;
  setOneTimeValues(values: Record<string, string>): void;
  setRebuildRevisionId(value: string | null): void;
}>) {
  const values = oneTimeRequest(server, oneTimeValues);
  if (!server.revisions.length) {
    return <p className="text-sm text-ink-muted">No activated revisions yet. Test and activate a draft to create the first immutable revision.</p>;
  }
  return (
    <div className="grid gap-4">
      <div>
        <h4 className="text-sm font-semibold text-ink">Activated revisions</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Rollback reuses an available exact artifact. A missing local artifact must be rebuilt, retested, and activated.</p>
      </div>
      <OneTimeValues
        disabled={controller.state.busy}
        onChange={(slotKey, value) => setOneTimeValues({ ...oneTimeValues, [slotKey]: value })}
        server={server}
        values={oneTimeValues}
      />
      <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
        {[...server.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber).map((revision) => {
          const active = revision.id === server.activeRevision?.id;
          const rebuilding = revision.id === rebuildRevisionId;
          const artifact = revision.artifactStatus === "not_applicable"
            ? "Remote source · no local artifact"
            : revision.artifactStatus === "available"
              ? "Artifact available"
              : revision.artifactStatus === "missing"
                ? "Artifact missing"
                : "Artifact not yet verified";
          return (
            <section className="grid gap-3 py-4" key={revision.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h5 className="text-sm font-medium text-ink">Revision {revision.revisionNumber}{active ? " · Current" : ""}</h5>
                  <p className="mt-1 text-xs text-ink-muted">Tested {new Date(revision.validationEvidence.testedAt).toLocaleString()} · {revision.validationEvidence.toolInventory.length} tools</p>
                  <p className={`mt-1 text-xs ${revision.artifactStatus === "missing" ? "text-critical" : revision.artifactStatus === "available" ? "text-positive" : "text-ink-muted"}`}>{artifact}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!active ? (
                    <button
                      className={quietButton}
                      disabled={controller.state.busy || Boolean(server.archivedAt) || revision.artifactStatus === "missing"}
                      onClick={() => void controller.actions.rollback(server.id, { revisionId: revision.id })}
                      title={revision.artifactStatus === "missing" ? "Rebuild and activate this revision because its cached artifact is missing." : undefined}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="size-3.5" />
                      Roll back
                    </button>
                  ) : null}
                  <button className={quietButton} disabled={controller.state.busy || Boolean(server.archivedAt)} onClick={() => setRebuildRevisionId(rebuilding ? null : revision.id)} type="button">
                    <Wrench aria-hidden="true" className="size-3.5" />
                    Rebuild
                  </button>
                </div>
              </div>
              {rebuilding ? (
                <div className="border-l-2 border-caution bg-caution/10 px-3 py-3 text-xs leading-5 text-caution">
                  <p>Rebuild replaces the current mutable draft with revision {revision.revisionNumber}, tests a newly materialized artifact, and immediately activates the result.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className={primaryButton}
                      disabled={controller.state.busy}
                      onClick={async () => {
                        try {
                          const ok = await controller.actions.rebuild(server.id, {
                            oneTimeValues: values,
                            replaceDraft: true,
                            revisionId: revision.id
                          });
                          if (ok) setRebuildRevisionId(null);
                        } finally {
                          setOneTimeValues({});
                        }
                      }}
                      type="button"
                    >
                      Replace draft, rebuild, and activate
                    </button>
                    <button className={quietButton} disabled={controller.state.busy} onClick={() => setRebuildRevisionId(null)} type="button">Cancel</button>
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RuntimeTask({ controller, server }: Readonly<{
  controller: AdminMcpController;
  server: AdminMcpServer;
}>) {
  const archived = Boolean(server.archivedAt);
  return (
    <div className="grid gap-6">
      <section>
        <h4 className="text-sm font-semibold text-ink">Availability to users</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Enable or disable whether the active installation revision is offered to users who already have MCP access. Access assignments remain in Users and Model access.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={`font-mono text-xs font-medium ${archived ? "text-critical" : server.enabled ? "text-positive" : "text-caution"}`}>
            {archived ? "LEGACY ARCHIVED" : server.enabled ? "ENABLED" : "DISABLED"}
          </span>
          {!archived ? (
            <button
              className={server.enabled ? quietButton : primaryButton}
              disabled={controller.state.busy || (!server.activeRevision && !server.enabled)}
              onClick={() => void controller.actions.update(server.id, { enabled: !server.enabled })}
              type="button"
            >
              {server.enabled ? "Disable" : "Enable"}
            </button>
          ) : null}
        </div>
      </section>
      <section className="border-t border-trace-subtle pt-4">
        <h4 className="text-sm font-semibold text-ink">Runtime evidence boundary</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">MCP readiness is user-scoped and can depend on each user’s OAuth or personal values. This admin catalog does not return aggregate runtime health, so validation evidence is not presented as live health.</p>
      </section>
    </div>
  );
}

function DangerTask({ controller, server }: Readonly<{
  controller: AdminMcpController;
  server: AdminMcpServer;
}>) {
  const [confirm, setConfirm] = useState(false);
  if (server.archivedAt) {
    return <p className="text-sm text-ink-muted">Legacy archived records are read-only. No Archive, restore, or delete action is available here.</p>;
  }
  return (
    <section className="max-w-3xl border-l-2 border-critical bg-critical/10 px-4 py-4">
      <h4 className="text-sm font-semibold text-ink">Delete server</h4>
      <p className="mt-1 text-xs leading-5 text-ink-secondary">Deletion is irreversible. {server.name} disappears from catalogs and new runs immediately; already accepted runs may finish and keep their recorded tool evidence.</p>
      {confirm ? (
        <div className="mt-4 grid gap-3 text-xs text-critical">
          <p>Delete {server.name}? This cannot be undone.</p>
          <div className="flex flex-wrap gap-2">
            <button className={dangerButton} disabled={controller.state.busy} onClick={() => void controller.actions.delete(server.id)} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete server
            </button>
            <button className={quietButton} disabled={controller.state.busy} onClick={() => setConfirm(false)} type="button">Cancel</button>
          </div>
        </div>
      ) : (
        <button className={`${dangerButton} mt-4`} disabled={controller.state.busy} onClick={() => setConfirm(true)} type="button">
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete…
        </button>
      )}
    </section>
  );
}

function TaskBody({
  controller,
  onEdit,
  onOpenTask,
  oneTimeValues,
  rebuildRevisionId,
  server,
  setOneTimeValues,
  setRebuildRevisionId,
  task
}: Readonly<{
  controller: AdminMcpController;
  onEdit(): void;
  onOpenTask(task: AdminMcpTask): void;
  oneTimeValues: Record<string, string>;
  rebuildRevisionId: string | null;
  server: AdminMcpServer;
  setOneTimeValues(values: Record<string, string>): void;
  setRebuildRevisionId(value: string | null): void;
  task: AdminMcpTask;
}>) {
  if (task === "definition") return <DefinitionTask controller={controller} onEdit={onEdit} server={server} />;
  if (task === "validation") return <ValidationTask controller={controller} oneTimeValues={oneTimeValues} server={server} setOneTimeValues={setOneTimeValues} />;
  if (task === "revisions") return <RevisionsTask controller={controller} oneTimeValues={oneTimeValues} rebuildRevisionId={rebuildRevisionId} server={server} setOneTimeValues={setOneTimeValues} setRebuildRevisionId={setRebuildRevisionId} />;
  if (task === "runtime") return <RuntimeTask controller={controller} server={server} />;
  if (task === "danger") return <DangerTask controller={controller} server={server} />;
  return <OverviewTask controller={controller} onOpenTask={onOpenTask} server={server} />;
}

export function AdminMcpServerWorkspace({
  compactTaskOpen,
  controller,
  onBackToCatalog,
  onEdit,
  onOpenTask,
  onShowTaskIndex,
  server,
  task
}: Readonly<{
  compactTaskOpen: boolean;
  controller: AdminMcpController;
  onBackToCatalog(): void;
  onEdit(): void;
  onOpenTask(task: AdminMcpTask): void;
  onShowTaskIndex(): void;
  server: AdminMcpServer;
  task: AdminMcpTask;
}>) {
  const [oneTimeValues, setOneTimeValues] = useState<Record<string, string>>({});
  const [rebuildRevisionId, setRebuildRevisionId] = useState<string | null>(null);

  const openTask = (nextTask: AdminMcpTask) => {
    setOneTimeValues({});
    setRebuildRevisionId(null);
    onOpenTask(nextTask);
  };

  const current = tasks.find((item) => item.id === task) ?? tasks[0];

  return (
    <AdminTaskWorkspace className="min-h-[34rem]" indexWidth="13.5rem">
      <AdminTaskIndexPane compactDetailOpen={compactTaskOpen} testId="mcp-server-task-index">
        <div className="p-4">
          <AdminTaskBackButton label="Back to MCP servers" onClick={onBackToCatalog} />
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Selected server</p>
          <h3 className="mt-1 break-words text-base font-semibold text-ink [overflow-wrap:anywhere]">{server.name}</h3>
          <p className="mt-1 break-words font-mono text-[11px] leading-4 text-ink-muted [overflow-wrap:anywhere]">{sourceDisplay(server.draft.source)}</p>
        </div>
        <nav className="border-t border-trace-subtle p-2" aria-label="MCP server tasks">
          {tasks.map((item) => {
            const Icon = item.icon;
            const active = item.id === task;
            return (
              <button
                className={`flex min-h-control w-full min-w-0 items-center gap-2 border-l-2 px-3 py-2 text-left ${active ? "border-proof bg-answer-paper text-ink" : "border-transparent text-ink-secondary hover:bg-control-hover hover:text-ink"}`}
                key={item.id}
                onClick={() => openTask(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-ink-muted">{item.description}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 lg:hidden" />
              </button>
            );
          })}
        </nav>
      </AdminTaskIndexPane>
      <AdminTaskDetailPane compactDetailOpen={compactTaskOpen} testId="mcp-server-task-detail">
        <article className="min-w-0 p-4 sm:p-5 lg:p-6">
          <AdminTaskBackButton label="Back to server tasks" onClick={onShowTaskIndex} />
          <header className="mb-6 border-b border-trace-subtle pb-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{server.name}</p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{current.label}</h3>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{current.description}</p>
          </header>
          <TaskBody
            controller={controller}
            onEdit={onEdit}
            onOpenTask={openTask}
            oneTimeValues={oneTimeValues}
            rebuildRevisionId={rebuildRevisionId}
            server={server}
            setOneTimeValues={setOneTimeValues}
            setRebuildRevisionId={setRebuildRevisionId}
            task={task}
          />
        </article>
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}
