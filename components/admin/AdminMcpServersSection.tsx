"use client";

import { AdminMcpDraftEditor } from "@/components/admin/AdminMcpDraftEditor";
import {
  activeInventory,
  diffMcpToolInventory,
  draftInventory,
  requestMcpSharedValues,
  sourceDisplay,
  type AdminMcpServerForm
} from "@/components/admin/adminMcpDraft";
import {
  EmptyState,
  dangerButton,
  focusRing,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type {
  AdminMcpEditorMode,
  AdminMcpSectionState
} from "@/components/admin/useAdminMcpSectionState";
import type {
  AdminMcpServer,
  McpConfigurationSlot,
  McpSlotValue,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import {
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  TestTube2,
  Trash2,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type AdminMcpServersSectionProps = Readonly<{
  controller: AdminMcpController;
  section: AdminMcpSectionState;
}>;

const fieldLabel = "text-xs font-medium text-content-secondary";
const helpText = "mt-1 text-[11px] leading-4 text-content-muted";

type AdminMcpOAuthReturn = Readonly<{
  kind: "cancelled" | "connected" | "failed" | null;
  serverId: string | null;
}>;

function readAdminMcpOAuthReturn(): AdminMcpOAuthReturn | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (url.searchParams.get("section") !== "mcp") return null;
  const rawKind = url.searchParams.get("oauth");
  const kind = rawKind === "connected" || rawKind === "cancelled" || rawKind === "failed"
    ? rawKind
    : null;
  const serverId = url.searchParams.get("server");
  return kind || serverId ? { kind, serverId } : null;
}


function StatusPill({ server }: { server: AdminMcpServer }) {
  const status = server.archivedAt
    ? { label: "Archived", tone: "bg-accent-rose/10 text-accent-rose" }
    : server.enabled
      ? { label: "Enabled", tone: "bg-accent-green/10 text-accent-green" }
      : { label: "Disabled", tone: "bg-surface-raised text-content-muted" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] ${status.tone}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {status.label}
    </span>
  );
}

function Feedback({ controller }: { controller: AdminMcpController }) {
  const { error, notice } = controller.state;
  if (!error && !notice) return null;
  return (
    <div className="grid gap-2 px-4 pt-3">
      {error ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-control bg-accent-rose/10 px-3 py-2 text-xs leading-5 text-accent-rose sm:flex-row sm:items-start sm:justify-between" role="alert">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
          <button className={quietButton} onClick={controller.actions.dismissError} type="button">Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-control bg-accent-green/10 px-3 py-2 text-xs leading-5 text-accent-green sm:flex-row sm:items-start sm:justify-between" role="status">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice}</span>
          <button className={quietButton} onClick={controller.actions.dismissNotice} type="button">Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}

function ServerList({
  controller,
  onCreate,
  onSelect,
  query,
  setQuery
}: Readonly<{
  controller: AdminMcpController;
  onCreate(): void;
  onSelect(serverId: string): void;
  query: string;
  setQuery(value: string): void;
}>) {
  const selected = controller.state.selectedServer;
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return controller.state.servers;
    return controller.state.servers.filter((server) =>
      [server.name, server.description, server.namespace, sourceDisplay(server.draft.source)]
        .some((value) => value.toLowerCase().includes(normalized))
    );
  }, [controller.state.servers, query]);

  return (
    <aside className="min-w-0 border-b border-separator-subtle lg:border-b-0 lg:border-r">
      <div className="grid gap-2 border-b border-separator-subtle p-3">
        <div className="flex flex-wrap gap-2">
          <button className={primaryButton} disabled={controller.state.busy} onClick={onCreate} type="button">
            <Plus aria-hidden="true" className="size-3.5" />
            New server
          </button>
        </div>
        <label className="relative block">
          <span className="sr-only">Search MCP servers</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-content-muted" />
          <input
            className={`${inputClass} pl-9`}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search MCP servers"
            type="search"
            value={query}
          />
        </label>
      </div>
      <div className="max-h-[36rem] overflow-y-auto p-2">
        {visible.length ? (
          <div aria-label="MCP server catalog" className="grid gap-1" role="list">
            {visible.map((server) => {
              const current = server.id === selected?.id;
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={[
                    `flex min-h-touch min-w-0 items-center gap-2 rounded-control px-3 py-2 text-left ${focusRing}`,
                    current ? "bg-surface-selected" : "hover:bg-surface-hover"
                  ].join(" ")}
                  key={server.id}
                  onClick={() => onSelect(server.id)}
                  role="listitem"
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-medium text-content-primary [overflow-wrap:anywhere]">{server.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-content-muted">{sourceDisplay(server.draft.source)}</span>
                  </span>
                  <StatusPill server={server} />
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-content-muted" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-3 py-8 text-center text-xs text-content-muted">
            {controller.state.servers.length ? "No matching MCP servers." : "No MCP servers yet."}
          </p>
        )}
      </div>
    </aside>
  );
}

function ImportForm({
  disabled,
  error,
  onCancel,
  onManual,
  onNormalize,
  setValue,
  value
}: Readonly<{
  disabled: boolean;
  error: string | null;
  onCancel(): void;
  onManual(): void;
  onNormalize(): void;
  setValue(value: string): void;
  value: string;
}>) {
  return (
    <section className="grid min-w-0 gap-4 p-4">
      <div>
        <h3 className="text-sm font-semibold text-content-primary">Add an MCP server</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-content-muted">
          Paste the configuration MCP providers normally give you. AIQSA understands a direct HTTP URL, one <span className="font-mono">mcpServers</span> JSON entry, or a common npx, uvx, pipx, pip install, docker, or podman command and shows the normalized draft before saving it.
        </p>
      </div>
      <label>
        <span className={fieldLabel}>Configuration JSON, URL, or install command</span>
        <textarea
          aria-describedby={error ? "mcp-import-error" : undefined}
          className={`${inputClass} min-h-64 py-3 font-mono text-xs`}
          disabled={disabled}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder={'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@example/mcp"] }\n  }\n}\n\nor paste: npx -y @example/mcp@latest'}
          value={value}
        />
      </label>
      {error ? <p className="text-xs text-accent-rose" id="mcp-import-error" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={disabled || !value.trim()} onClick={onNormalize} type="button">
          <ClipboardPaste aria-hidden="true" className="size-3.5" />
          Normalize and review
        </button>
        <button className={quietButton} disabled={disabled} onClick={onManual} type="button">Configure manually</button>
        <button className={quietButton} disabled={disabled} onClick={onCancel} type="button">Cancel</button>
      </div>
    </section>
  );
}

function ServerEditor({
  disabled,
  form,
  imported,
  mode,
  onCancel,
  onSave,
  setForm,
  storedSharedValues
}: Readonly<{
  disabled: boolean;
  form: AdminMcpServerForm;
  imported: boolean;
  mode: Exclude<AdminMcpEditorMode, "import" | null>;
  onCancel(): void;
  onSave(): void;
  setForm(form: AdminMcpServerForm): void;
  storedSharedValues?: AdminMcpServer["sharedValues"];
}>) {
  return (
    <section className="grid min-w-0 gap-4 p-4">
      <div>
        <h3 className="text-sm font-semibold text-content-primary">
          {mode === "create" ? "Create MCP server draft" : "Edit MCP server draft"}
        </h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-content-muted">
          {imported
            ? "Imported values were normalized into AIQSA's supported source and typed-field model. Review every field before saving."
            : "Saving changes invalidates prior draft-test evidence. The active revision keeps running until a new tested draft is activated."}
        </p>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label>
          <span className={fieldLabel}>Display name</span>
          <input
            className={inputClass}
            disabled={disabled}
            maxLength={120}
            onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            value={form.name}
          />
        </label>
        <label className="md:col-span-2">
          <span className={fieldLabel}>Description</span>
          <textarea
            className={`${inputClass} min-h-20 py-2`}
            disabled={disabled}
            maxLength={4000}
            onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
            value={form.description}
          />
        </label>
      </div>
      <AdminMcpDraftEditor
        disabled={disabled}
        draft={form.draft}
        onChange={(draft) => setForm({ ...form, draft })}
        onSharedValueChange={(slotKey, value) => setForm({
          ...form,
          sharedValues: { ...form.sharedValues, [slotKey]: value }
        })}
        sharedValueDraft={form.sharedValues}
        storedSharedValues={storedSharedValues}
      />
      <div className="flex flex-wrap gap-2 border-t border-separator-subtle pt-4">
        <button className={primaryButton} disabled={disabled || !form.name.trim()} onClick={onSave} type="button">
          {disabled ? "Saving…" : mode === "create" ? "Create draft" : "Save draft"}
        </button>
        <button className={quietButton} disabled={disabled} onClick={onCancel} type="button">Cancel</button>
      </div>
    </section>
  );
}

function slotInputValue(slot: McpConfigurationSlot, raw: string): McpSlotValue {
  if (slot.valueType === "number") return Number(raw);
  if (slot.valueType === "boolean") return raw === "true";
  return raw;
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
    <div className="grid gap-3 rounded-control bg-surface-thread p-3">
      <div>
        <h5 className="text-xs font-medium text-content-secondary">One-time validation values</h5>
        <p className={helpText}>Used only by the next Test, update check, or Rebuild request. Values are not saved as shared or personal configuration.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {candidates.map((slot) => (
          <label key={slot.slotKey}>
            <span className={fieldLabel}>{slot.label}</span>
            {slot.valueType === "boolean" ? (
              <select
                className={inputClass}
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
                className={inputClass}
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
                className={inputClass}
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

function InventoryList({
  empty,
  tools
}: Readonly<{ empty: string; tools: readonly McpToolInventoryEntry[] }>) {
  if (!tools.length) return <p className="text-xs text-content-muted">{empty}</p>;
  return (
    <ul className="grid gap-2">
      {tools.map((tool) => (
        <li className="min-w-0 rounded-control bg-surface-thread px-3 py-2" key={tool.name}>
          <div className="break-words font-mono text-xs text-content-primary [overflow-wrap:anywhere]">{tool.name}</div>
          {tool.description ? <p className="mt-1 break-words text-xs leading-5 text-content-muted [overflow-wrap:anywhere]">{tool.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ValidationAndTools({
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
  const candidate = draftInventory(server);
  const diff = diffMcpToolInventory(active, candidate);
  const values = oneTimeRequest(server, oneTimeValues);
  const busy = controller.state.busy || Boolean(server.archivedAt);
  return (
    <section className="grid min-w-0 gap-3 rounded-panel bg-surface-raised/55 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-xs font-semibold text-content-primary">Validation and tool inventory</h4>
          <p className={helpText}>Test connects to the exact draft, discovers its complete tools, and records evidence required for activation.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={quietButton}
            disabled={busy}
            onClick={() => void controller.actions.test(server.id, { oneTimeValues: values })}
            type="button"
          >
            <TestTube2 aria-hidden="true" className="size-3.5" />
            Test draft
          </button>
          <button
            className={quietButton}
            disabled={busy}
            onClick={() => void controller.actions.checkUpdate(server.id, { oneTimeValues: values })}
            type="button"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Check for update
          </button>
        </div>
      </div>
      <OneTimeValues
        disabled={controller.state.busy}
        onChange={(slotKey, value) => setOneTimeValues({ ...oneTimeValues, [slotKey]: value })}
        server={server}
        values={oneTimeValues}
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="grid content-start gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-xs font-medium text-content-secondary">Tested draft tools</h5>
            <span className="font-mono text-[11px] text-content-muted">{candidate.length}</span>
          </div>
          <InventoryList empty={server.draftTested ? "The tested server exposed no tools." : "Test the current draft to discover tools."} tools={candidate} />
        </div>
        <div className="grid content-start gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-xs font-medium text-content-secondary">Change from active revision</h5>
            <span className="text-[11px] text-content-muted">
              +{diff.added.length} added · {diff.changed.length} changed · −{diff.removed.length} removed
            </span>
          </div>
          {!server.draftTest ? (
            <p className="text-xs text-content-muted">A diff appears after the current draft passes validation.</p>
          ) : (
            <div className="grid gap-2 text-xs">
              {diff.added.length ? <p className="text-accent-green">Added: {diff.added.map((tool) => tool.name).join(", ")}</p> : null}
              {diff.changed.length ? <p className="text-accent-amber">Changed: {diff.changed.map((tool) => tool.name).join(", ")}</p> : null}
              {diff.removed.length ? <p className="text-accent-rose">Removed: {diff.removed.map((tool) => tool.name).join(", ")}</p> : null}
              {!diff.added.length && !diff.changed.length && !diff.removed.length ? (
                <p className="text-content-muted">No tool changes from the active revision.</p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Revisions({
  controller,
  oneTimeValues,
  rebuildRevisionId,
  server,
  setRebuildRevisionId
}: Readonly<{
  controller: AdminMcpController;
  oneTimeValues: Record<string, string>;
  rebuildRevisionId: string | null;
  server: AdminMcpServer;
  setRebuildRevisionId(value: string | null): void;
}>) {
  const values = oneTimeRequest(server, oneTimeValues);
  if (!server.revisions.length) return null;
  return (
    <section className="grid gap-3 rounded-panel bg-surface-raised/55 p-3">
      <div>
        <h4 className="text-xs font-semibold text-content-primary">Activated revisions</h4>
        <p className={helpText}>Rollback is best-effort for local artifacts. Rebuild copies a selected revision into the mutable draft and materializes it again.</p>
      </div>
      <div className="grid gap-2">
        {[...server.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber).map((revision) => {
          const active = revision.id === server.activeRevision?.id;
          const rebuilding = revision.id === rebuildRevisionId;
          return (
            <div className="grid gap-2 rounded-control bg-surface-thread p-3" key={revision.id}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-xs font-medium text-content-primary">Revision {revision.revisionNumber}{active ? " · Current" : ""}</div>
                  <div className="mt-1 text-[11px] text-content-muted">
                    Tested {new Date(revision.validationEvidence.testedAt).toLocaleString()} · {revision.validationEvidence.toolInventory.length} tools
                    {revision.artifactStatus === "missing" ? " · Artifact missing" : revision.artifactStatus === "available" ? " · Artifact available" : revision.artifactStatus === "unknown" ? " · Artifact not yet verified" : ""}
                  </div>
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
                  <button
                    className={quietButton}
                    disabled={controller.state.busy || Boolean(server.archivedAt)}
                    onClick={() => setRebuildRevisionId(rebuilding ? null : revision.id)}
                    type="button"
                  >
                    <Wrench aria-hidden="true" className="size-3.5" />
                    Rebuild
                  </button>
                </div>
              </div>
              {rebuilding ? (
                <div className="grid gap-2 border-t border-separator-subtle pt-3">
                  <p className="text-xs leading-5 text-accent-amber">Rebuild replaces the current mutable draft with revision {revision.revisionNumber}, tests a newly materialized artifact, and immediately activates the resulting revision.</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={primaryButton}
                      disabled={controller.state.busy}
                      onClick={async () => {
                        const ok = await controller.actions.rebuild(server.id, {
                          oneTimeValues: values,
                          replaceDraft: true,
                          revisionId: revision.id
                        });
                        if (ok) setRebuildRevisionId(null);
                      }}
                      type="button"
                    >
                      Rebuild and activate
                    </button>
                    <button className={quietButton} disabled={controller.state.busy} onClick={() => setRebuildRevisionId(null)} type="button">Cancel</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OAuthValidation({ controller, server }: { controller: AdminMcpController; server: AdminMcpServer }) {
  if (server.draft.auth.mode !== "oauth") return null;
  const encoded = encodeURIComponent(server.id);
  const connection = server.validationOAuth;
  const ready = connection?.state === "ready";
  const needsReconnect = connection?.state === "reauthorization_required";
  const disconnecting = connection?.state === "disconnecting";
  return (
    <section className="grid gap-3 rounded-panel bg-surface-raised/55 p-3">
      <div>
        <h4 className="text-xs font-semibold text-content-primary">Validation OAuth identity</h4>
        <p className={helpText}>Use an administrator-owned external identity only to test this installation draft. Users authorize their own identities separately.</p>
      </div>
      <div className={`rounded-control px-3 py-2 text-xs leading-5 ${ready ? "bg-accent-green/10 text-accent-green" : needsReconnect ? "bg-accent-amber/10 text-accent-amber" : "bg-surface-thread text-content-secondary"}`}>
        <div>{ready ? "Connected" : needsReconnect ? "Reauthorization required" : disconnecting ? "Disconnecting" : "Not connected"}</div>
        {connection?.accountLabel ? <div className="mt-1 break-words text-[11px] [overflow-wrap:anywhere]">External account: {connection.accountLabel}</div> : null}
        {connection?.connectedAt ? <div className="mt-1 text-[11px] opacity-80">Last connected {new Date(connection.connectedAt).toLocaleString()}</div> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <form action={`/api/admin/mcp/${encoded}/oauth/validation/connect`} method="post">
          <button className={ready ? quietButton : primaryButton} type="submit">
            {ready ? "Check connection" : "Connect"}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </button>
        </form>
        <form action={`/api/admin/mcp/${encoded}/oauth/validation/reconnect`} method="post">
          <button className={quietButton} type="submit">
            Reconnect
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </button>
        </form>
        <button
          className={quietButton}
          disabled={controller.state.busy || !connection || connection.state === "disconnected" || disconnecting}
          onClick={() => void controller.actions.disconnectValidationOAuth(server.id)}
          type="button"
        >
          Disconnect
        </button>
      </div>
    </section>
  );
}

function ServerDetail({
  controller,
  onEdit,
  server
}: Readonly<{
  controller: AdminMcpController;
  onEdit(): void;
  server: AdminMcpServer;
}>) {
  const [oneTimeValues, setOneTimeValues] = useState<Record<string, string>>({});
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [rebuildRevisionId, setRebuildRevisionId] = useState<string | null>(null);
  const archived = Boolean(server.archivedAt);
  const testedRevisionIsActive = Boolean(server.activeRevision && server.draftTest &&
    server.draftTest.identityHash === server.activeRevision.identityHash);
  const activationAvailable = server.draftTested && !testedRevisionIsActive;
  return (
    <article className="grid min-w-0 gap-3 p-4">
      <div className="flex min-w-0 flex-col gap-3 border-b border-separator-subtle pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">{server.name}</h3>
            <StatusPill server={server} />
          </div>
          <p className="mt-1 break-words text-sm leading-6 text-content-muted [overflow-wrap:anywhere]">{server.description || "No description."}</p>
          <p className="mt-1 break-words font-mono text-[11px] text-content-muted [overflow-wrap:anywhere]">{sourceDisplay(server.draft.source)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button className={quietButton} disabled={controller.state.busy || archived} onClick={onEdit} type="button">
            <Pencil aria-hidden="true" className="size-3.5" />
            Edit draft
          </button>
          {!archived ? (
            <button
              className={quietButton}
              disabled={controller.state.busy || (!server.activeRevision && !server.enabled)}
              onClick={() => void controller.actions.update(server.id, { enabled: !server.enabled })}
              type="button"
            >
              {server.enabled ? "Disable" : "Enable"}
            </button>
          ) : null}
        </div>
      </div>

      <section className="grid gap-3 rounded-panel bg-accent-amber/10 p-3 text-xs leading-5 text-accent-amber">
        <div className="flex items-start gap-2">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>Activation trusts this server as one unit. The model may invoke every current or future valid tool it exposes, including state-changing tools. Local workloads also have unrestricted outbound network access.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {activationAvailable ? (
            <button
              className={primaryButton}
              disabled={controller.state.busy || archived}
              onClick={() => void controller.actions.activate(server.id)}
              type="button"
            >
              Activate tested revision
            </button>
          ) : testedRevisionIsActive ? (
            <span className="self-center text-[11px]">The tested revision is active.</span>
          ) : (
            <span className="self-center text-[11px]">Test the unchanged current draft before activation.</span>
          )}
        </div>
      </section>

      <section className="grid gap-2 rounded-panel bg-surface-raised/55 p-3">
        <h4 className="text-xs font-semibold text-content-primary">Installation evidence</h4>
        <div className="grid gap-2 text-xs text-content-secondary sm:grid-cols-3">
          <div><span className="text-content-muted">Active revision</span><div className="mt-1">{server.activeRevision ? `Revision ${server.activeRevision.revisionNumber}` : "None"}</div></div>
          <div><span className="text-content-muted">Draft test</span><div className="mt-1">{server.draftTested ? "Current and tested" : "Not tested or changed"}</div></div>
          <div><span className="text-content-muted">Runtime health</span><div className="mt-1">User-scoped; not returned by this admin catalog</div></div>
        </div>
      </section>

      <OAuthValidation controller={controller} server={server} />
      <ValidationAndTools
        controller={controller}
        oneTimeValues={oneTimeValues}
        server={server}
        setOneTimeValues={setOneTimeValues}
      />
      <Revisions
        controller={controller}
        oneTimeValues={oneTimeValues}
        rebuildRevisionId={rebuildRevisionId}
        server={server}
        setRebuildRevisionId={setRebuildRevisionId}
      />

      {!archived ? (
        <section className="grid gap-3 rounded-panel bg-surface-raised/55 p-3">
          <div>
            <h4 className="text-xs font-semibold text-content-primary">Delete server</h4>
            <p className={helpText}>Deletion is irreversible. The server disappears from catalogs and new runs immediately; already accepted runs may finish and retain their recorded tool evidence.</p>
          </div>
          {deleteConfirm ? (
            <div className="grid gap-2 rounded-control bg-accent-rose/10 p-3 text-xs text-accent-rose">
              <p>Delete {server.name}? This cannot be undone.</p>
              <div className="flex flex-wrap gap-2">
                <button className={dangerButton} disabled={controller.state.busy} onClick={() => void controller.actions.delete(server.id)} type="button">
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Delete server
                </button>
                <button className={quietButton} disabled={controller.state.busy} onClick={() => setDeleteConfirm(false)} type="button">Cancel</button>
              </div>
            </div>
          ) : (
            <button className={`${dangerButton} justify-self-start`} disabled={controller.state.busy} onClick={() => setDeleteConfirm(true)} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete…
            </button>
          )}
        </section>
      ) : null}
    </article>
  );
}

export function AdminMcpServersSection({ controller, section }: AdminMcpServersSectionProps) {
  const { actions, state } = section;
  const { form, importError, imported, importValue, mode, query } = state;
  const [oauthReturn] = useState<AdminMcpOAuthReturn | null>(readAdminMcpOAuthReturn);
  const selected = controller.state.selectedServer;

  useEffect(() => {
    if (!controller.state.loaded || !oauthReturn || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("oauth") && !url.searchParams.has("server")) return;
    if (oauthReturn.serverId && controller.state.servers.some((server) => server.id === oauthReturn.serverId)) {
      controller.actions.select(oauthReturn.serverId);
    }
    url.searchParams.delete("oauth");
    url.searchParams.delete("server");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [controller.actions, controller.state.loaded, controller.state.servers, oauthReturn]);

  const save = async () => {
    const sharedValues = requestMcpSharedValues(form);
    if (mode === "create") {
      const created = await controller.actions.create({
        description: form.description,
        draft: form.draft,
        name: form.name.trim(),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (created) actions.closeEditor();
    } else if (mode === "edit" && selected) {
      const saved = await controller.actions.update(selected.id, {
        description: form.description,
        draft: form.draft,
        name: form.name.trim(),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (saved) actions.closeEditor();
    }
  };

  const oauthOutcome = oauthReturn?.kind ?? null;

  return (
    <div className="min-w-0">
      <Feedback controller={controller} />
      {oauthOutcome ? (
        <div className={`mx-4 mt-3 rounded-control px-3 py-2 text-xs ${oauthOutcome === "connected" ? "bg-accent-green/10 text-accent-green" : oauthOutcome === "cancelled" ? "bg-accent-amber/10 text-accent-amber" : "bg-accent-rose/10 text-accent-rose"}`} role="status">
          {oauthOutcome === "connected"
            ? "Validation OAuth completed. AIQSA tested and activated the server automatically."
            : oauthOutcome === "cancelled"
              ? "Validation OAuth was cancelled. The draft remains inactive."
              : "Validation OAuth or automatic server validation failed. Review the selected server and try again."}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-separator-subtle px-4 py-3">
        <p className="text-xs text-content-muted">
          {controller.state.loading ? "Loading MCP catalog…" : `${controller.state.servers.length} installation-owned server${controller.state.servers.length === 1 ? "" : "s"}`}
        </p>
        <button className={quietButton} disabled={controller.state.loading || controller.state.busy} onClick={() => void controller.actions.refresh()} type="button">
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Refresh MCP
        </button>
      </div>
      {controller.state.loading && !controller.state.loaded ? (
        <div className="px-4 py-12 text-center text-sm text-content-muted" role="status">Loading MCP servers…</div>
      ) : controller.state.error && !controller.state.loaded ? (
        <div className="grid justify-items-center gap-3 px-4 py-12 text-center">
          <p className="max-w-xl text-sm text-content-muted">MCP administration data is unavailable.</p>
          <button className={primaryButton} onClick={() => void controller.actions.refresh()} type="button">Retry</button>
        </div>
      ) : (
        <div className="grid min-w-0 lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,2fr)]">
          <ServerList
            controller={controller}
            onCreate={actions.startImport}
            onSelect={(serverId) => {
              actions.closeEditor();
              controller.actions.select(serverId);
            }}
            query={query}
            setQuery={actions.setQuery}
          />
          <div className="min-w-0">
            {mode === "import" ? (
              <ImportForm
                disabled={controller.state.busy}
                error={importError}
                onCancel={actions.closeEditor}
                onManual={actions.startCreate}
                onNormalize={actions.normalizeImport}
                setValue={actions.setImportValue}
                value={importValue}
              />
            ) : mode === "create" || mode === "edit" ? (
              <ServerEditor
                disabled={controller.state.busy}
                form={form}
                imported={imported}
                mode={mode}
                onCancel={actions.closeEditor}
                onSave={() => void save()}
                setForm={actions.setForm}
                storedSharedValues={mode === "edit" ? selected?.sharedValues : undefined}
              />
            ) : selected ? (
              <ServerDetail
                controller={controller}
                key={selected.id}
                onEdit={() => actions.startEdit(selected)}
                server={selected}
              />
            ) : (
              <EmptyState
                detail="Create a remote, npm, PyPI, or OCI MCP draft, test its exact revision, then activate it and grant the whole server to users or groups."
                title="No MCP server selected"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
