"use client";

import { AdminMcpDraftEditor } from "@/components/admin/AdminMcpDraftEditor";
import { AdminMcpServerWorkspace } from "@/components/admin/AdminMcpServerWorkspace";
import {
  requestMcpSharedValues,
  sourceDisplay,
  type AdminMcpServerForm
} from "@/components/admin/adminMcpDraft";
import {
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  EmptyState,
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
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import {
  ChevronRight,
  ClipboardPaste,
  Plus,
  RefreshCw,
  Search
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type AdminMcpServersSectionProps = Readonly<{
  controller: AdminMcpController;
  section: AdminMcpSectionState;
}>;

const fieldLabel = "text-xs font-medium text-ink-secondary";

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

function availability(server: AdminMcpServer): { label: string; tone: string } {
  if (server.archivedAt) return { label: "Legacy", tone: "bg-critical/10 text-critical" };
  if (server.enabled) return { label: "Enabled", tone: "bg-positive/10 text-positive" };
  return { label: "Disabled", tone: "bg-control-surface text-ink-muted" };
}

function StatusPill({ server }: Readonly<{ server: AdminMcpServer }>) {
  const status = availability(server);
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] ${status.tone}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {status.label}
    </span>
  );
}

function Feedback({ controller }: Readonly<{ controller: AdminMcpController }>) {
  const { error, notice } = controller.state;
  if (!error && !notice) return null;
  return (
    <div className="grid gap-2 px-4 pt-3">
      {error ? (
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs leading-5 text-critical sm:flex-row sm:items-start sm:justify-between" role="alert">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
          <button className={quietButton} onClick={controller.actions.dismissError} type="button">Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-positive bg-positive/10 px-3 py-2 text-xs leading-5 text-positive sm:flex-row sm:items-start sm:justify-between" role="status">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice}</span>
          <button className={quietButton} onClick={controller.actions.dismissNotice} type="button">Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}

function ServerCatalog({
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
    <div className="min-w-0">
      <div className="grid gap-3 border-b border-trace-subtle p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation catalog</p>
            <p className="mt-0.5 text-xs text-ink-secondary">{controller.state.servers.length} server{controller.state.servers.length === 1 ? "" : "s"}</p>
          </div>
          <button className={primaryButton} disabled={controller.state.busy} onClick={onCreate} type="button">
            <Plus aria-hidden="true" className="size-3.5" />
            New server
          </button>
        </div>
        <label className="relative block">
          <span className="sr-only">Search MCP servers</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${inputClass} pl-9`}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search servers"
            type="search"
            value={query}
          />
        </label>
      </div>
      <div className="max-h-[42rem] overflow-y-auto p-2">
        {visible.length ? (
          <div aria-label="MCP server catalog" className="grid gap-1" role="list">
            {visible.map((server) => {
              const current = server.id === selected?.id;
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={`flex min-h-touch min-w-0 items-center gap-2 border-l-2 px-3 py-2 text-left ${focusRing} ${current ? "border-proof bg-answer-paper" : "border-transparent hover:bg-control-hover"}`}
                  key={server.id}
                  onClick={() => onSelect(server.id)}
                  role="listitem"
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-medium text-ink [overflow-wrap:anywhere]">{server.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{sourceDisplay(server.draft.source)}</span>
                  </span>
                  <StatusPill server={server} />
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-3 py-10 text-center text-xs text-ink-muted">
            {controller.state.servers.length ? "No matching MCP servers." : "No MCP servers yet."}
          </p>
        )}
      </div>
    </div>
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
    <section className="grid min-w-0 gap-5 p-4 sm:p-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">New installation</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">Add an MCP server</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          Paste what the MCP provider gives you. AIQSA accepts a direct HTTP URL, one <span className="font-mono">mcpServers</span> JSON entry, or a recognized npx, uvx, pipx, pip install, docker, or podman command. It never executes pasted shell text.
        </p>
      </div>
      <label className="min-w-0">
        <span className={fieldLabel}>Configuration JSON, URL, or install command</span>
        <textarea
          aria-describedby={error ? "mcp-import-error" : undefined}
          className={`${inputClass} mt-1.5 min-h-64 py-3 font-mono text-xs`}
          disabled={disabled}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder={'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@example/mcp"] }\n  }\n}\n\nor paste: npx -y @example/mcp@latest'}
          value={value}
        />
      </label>
      {error ? <p className="text-xs text-critical" id="mcp-import-error" role="alert">{error}</p> : null}
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
    <section className="grid min-w-0 gap-5 p-4 sm:p-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Mutable installation draft</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{mode === "create" ? "Create MCP server" : "Edit MCP server"}</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          {imported
            ? "The imported values were normalized into supported source and typed-field contracts. Review them before saving."
            : "Saving invalidates prior draft-test evidence. An active revision keeps running until the next exact tested identity is activated."}
        </p>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label className="min-w-0">
          <span className={fieldLabel}>Display name</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} maxLength={120} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} value={form.name} />
        </label>
        <label className="min-w-0 md:col-span-2">
          <span className={fieldLabel}>Description</span>
          <textarea className={`${inputClass} mt-1.5 min-h-20 py-2`} disabled={disabled} maxLength={4000} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} value={form.description} />
        </label>
      </div>
      <AdminMcpDraftEditor
        disabled={disabled}
        draft={form.draft}
        onChange={(draft) => setForm({ ...form, draft })}
        onSharedValueChange={(slotKey, value) => setForm({ ...form, sharedValues: { ...form.sharedValues, [slotKey]: value } })}
        sharedValueDraft={form.sharedValues}
        storedSharedValues={storedSharedValues}
      />
      <div className="flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
        <button className={primaryButton} disabled={disabled || !form.name.trim()} onClick={onSave} type="button">
          {disabled ? "Saving…" : mode === "create" ? "Create draft" : "Save draft"}
        </button>
        <button className={quietButton} disabled={disabled} onClick={onCancel} type="button">Cancel</button>
      </div>
    </section>
  );
}

export function AdminMcpServersSection({ controller, section }: AdminMcpServersSectionProps) {
  const { actions, state } = section;
  const {
    compactDetailOpen,
    compactTaskOpen,
    form,
    importError,
    imported,
    importValue,
    mode,
    query,
    task
  } = state;
  const [oauthReturn] = useState<AdminMcpOAuthReturn | null>(readAdminMcpOAuthReturn);
  const selected = controller.state.selectedServer;

  useEffect(() => {
    if (!controller.state.loaded || !oauthReturn || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("oauth") && !url.searchParams.has("server")) return;
    if (oauthReturn.serverId && controller.state.servers.some((server) => server.id === oauthReturn.serverId)) {
      controller.actions.select(oauthReturn.serverId);
      actions.openTask("validation");
    }
    url.searchParams.delete("oauth");
    url.searchParams.delete("server");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [actions, controller.actions, controller.state.loaded, controller.state.servers, oauthReturn]);

  const cancelEditor = () => {
    actions.closeEditor();
    if (selected) actions.openServer();
    else actions.showCatalog();
  };

  const save = async () => {
    const sharedValues = requestMcpSharedValues(form);
    if (mode === "create") {
      const created = await controller.actions.create({
        description: form.description,
        draft: form.draft,
        name: form.name.trim(),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (created) actions.openServer();
    } else if (mode === "edit" && selected) {
      const saved = await controller.actions.update(selected.id, {
        description: form.description,
        draft: form.draft,
        name: form.name.trim(),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (saved) actions.openTask("overview");
    }
  };

  const oauthOutcome = oauthReturn?.kind ?? null;

  if (controller.state.loading && !controller.state.loaded) {
    return <div className="grid min-h-52 place-items-center px-4 py-12 text-sm text-ink-muted" role="status">Loading MCP servers…</div>;
  }

  if (controller.state.error && !controller.state.loaded) {
    return (
      <div className="grid justify-items-center gap-3 px-4 py-12 text-center">
        <p className="max-w-xl text-sm text-ink-muted">MCP administration data is unavailable.</p>
        <button className={primaryButton} onClick={() => void controller.actions.refresh()} type="button">Retry</button>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <Feedback controller={controller} />
      {oauthOutcome ? (
        <div className={`mx-4 mt-3 border-l-2 px-3 py-2 text-xs leading-5 ${oauthOutcome === "connected" ? "border-positive bg-positive/10 text-positive" : oauthOutcome === "cancelled" ? "border-caution bg-caution/10 text-caution" : "border-critical bg-critical/10 text-critical"}`} role="status">
          {oauthOutcome === "connected"
            ? "Validation OAuth completed. AIQSA tested and activated the server automatically."
            : oauthOutcome === "cancelled"
              ? "Validation OAuth was cancelled. The draft remains inactive."
              : "Validation OAuth or automatic server validation failed. Review the selected server and try again."}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-trace-subtle px-4 py-3">
        <p className="text-xs text-ink-muted">Installation-owned MCP control plane</p>
        <button className={quietButton} disabled={controller.state.loading || controller.state.busy} onClick={() => void controller.actions.refresh()} type="button">
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Refresh MCP
        </button>
      </div>
      <AdminTaskWorkspace indexWidth="18rem">
        <AdminTaskIndexPane compactDetailOpen={compactDetailOpen} testId="mcp-catalog-view">
          <ServerCatalog
            controller={controller}
            onCreate={actions.startImport}
            onSelect={(serverId) => {
              controller.actions.select(serverId);
              actions.openServer();
            }}
            query={query}
            setQuery={actions.setQuery}
          />
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen={compactDetailOpen} testId="mcp-detail-view">
          {mode === "import" ? (
            <div>
              <div className="px-4 pt-4"><AdminTaskBackButton label="Back to MCP servers" onClick={actions.showCatalog} /></div>
              <ImportForm
                disabled={controller.state.busy}
                error={importError}
                onCancel={cancelEditor}
                onManual={actions.startCreate}
                onNormalize={actions.normalizeImport}
                setValue={actions.setImportValue}
                value={importValue}
              />
            </div>
          ) : mode === "create" || mode === "edit" ? (
            <div>
              <div className="px-4 pt-4"><AdminTaskBackButton label="Back to MCP servers" onClick={actions.showCatalog} /></div>
              <ServerEditor
                disabled={controller.state.busy}
                form={form}
                imported={imported}
                mode={mode}
                onCancel={cancelEditor}
                onSave={() => void save()}
                setForm={actions.setForm}
                storedSharedValues={mode === "edit" ? selected?.sharedValues : undefined}
              />
            </div>
          ) : selected ? (
            <AdminMcpServerWorkspace
              compactTaskOpen={compactTaskOpen}
              controller={controller}
              key={selected.id}
              onBackToCatalog={actions.showCatalog}
              onEdit={() => actions.startEdit(selected)}
              onOpenTask={actions.openTask}
              onShowTaskIndex={actions.showTaskIndex}
              server={selected}
              task={task}
            />
          ) : (
            <EmptyState
              detail="Import or manually configure a remote, npm, PyPI, or OCI server, validate its exact draft, and activate the reviewed tool inventory."
              title="No MCP server selected"
            />
          )}
        </AdminTaskDetailPane>
      </AdminTaskWorkspace>
    </div>
  );
}
