"use client";

import { AdminMcpDraftEditor } from "@/components/admin/AdminMcpDraftEditor";
import { AdminMcpServerWorkspace } from "@/components/admin/AdminMcpServerWorkspace";
import {
  requestMcpSharedValues,
  sourceDisplay,
  type AdminMcpServerForm
} from "@/components/admin/adminMcpDraft";
import {
  adminMcpActivationStage,
  adminMcpActivationVerb
} from "@/components/admin/adminMcpActivation";
import {
  AdminAvailabilityStatus,
  adminAvailabilityRowClass,
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
  Braces,
  ChevronRight,
  CircleAlert,
  ClipboardPaste,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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

function StatusPill({ server }: Readonly<{ server: AdminMcpServer }>) {
  if (server.archivedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-critical/25 bg-critical/10 px-2 py-0.5 text-metadata font-medium text-critical">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        Legacy
      </span>
    );
  }
  return <AdminAvailabilityStatus enabled={server.enabled} />;
}

function Feedback({ controller }: Readonly<{ controller: AdminMcpController }>) {
  const { error, notice } = controller.state;
  if (!error && !notice) return null;
  const progressNotice = notice?.includes("continues in the background") ?? false;
  return (
    <div className="grid gap-2 px-4 pt-3">
      {error ? (
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs leading-5 text-critical sm:flex-row sm:items-start sm:justify-between" role="alert">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
          <button className={quietButton} onClick={controller.actions.dismissError} type="button">Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div className={`flex min-w-0 flex-col gap-2 border-l-2 px-3 py-2 text-xs leading-5 sm:flex-row sm:items-start sm:justify-between ${progressNotice ? "border-proof bg-proof/[0.07] text-proof" : "border-positive bg-positive/10 text-positive"}`} role="status">
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
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation catalog</p>
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
              const activationStage = adminMcpActivationStage(server);
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={`flex min-h-touch min-w-0 items-center gap-2 px-3 py-2 text-left ${focusRing} ${
                    server.archivedAt
                      ? "border-l-2 border-l-critical/55 bg-critical/5"
                      : adminAvailabilityRowClass(server.enabled)
                  } ${current ? "ring-1 ring-inset ring-proof/45" : "hover:bg-control-hover"}`}
                  data-resource-availability-row={server.archivedAt ? undefined : server.enabled ? "enabled" : "disabled"}
                  key={server.id}
                  onClick={() => onSelect(server.id)}
                  role="listitem"
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-medium text-ink [overflow-wrap:anywhere]">{server.name}</span>
                    <span className="mt-0.5 block truncate text-metadata text-ink-muted">{sourceDisplay(server.draft.source)}</span>
                    {activationStage ? (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-metadata font-medium text-proof">
                        <LoaderCircle aria-hidden="true" className="size-2.5 animate-spin" />
                        {adminMcpActivationVerb(server)} · {activationStage.label}
                      </span>
                    ) : null}
                    {server.activation?.stage === "failed" ? (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-metadata font-medium text-critical">
                        <CircleAlert aria-hidden="true" className="size-2.5" />
                        Activation failed · review and retry
                      </span>
                    ) : null}
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
  const lineCount = value ? value.split(/\r\n|\r|\n/u).length : 0;
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (error) editorRef.current?.focus();
  }, [error]);

  return (
    <section className="grid min-w-0 gap-5 p-4 sm:p-6">
      <div>
        <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">New installation</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">Add an MCP server</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          Paste what the MCP provider gives you. AIQSA accepts a direct HTTP URL, one <span className="font-mono">mcpServers</span> JSON entry, or a recognized npx, uvx, pipx, pip install, docker, or podman command. It never executes pasted shell text.
        </p>
      </div>
      <div className="min-w-0">
        <label className={fieldLabel} htmlFor="mcp-import-document">
          Configuration JSON, URL, or install command
        </label>
        <div
          className={`group mt-2 min-w-0 overflow-hidden rounded-panel border bg-answer-paper transition-[border-color,box-shadow,background-color] duration-150 ease-out focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-answer-paper ${
            error
              ? "border-critical bg-critical/[0.025] focus-within:border-critical focus-within:ring-focus"
              : disabled
                ? "border-trace-subtle"
                : "border-control-boundary focus-within:border-focus focus-within:ring-focus"
          }`}
          data-testid="mcp-configuration-document"
        >
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-trace-subtle bg-workspace-rail/55 px-3 py-2 sm:px-4">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-secondary">
              <Braces aria-hidden="true" className="size-3.5 text-proof" />
              Configuration document
            </span>
            <span className="flex items-center gap-2">
              <span className="rounded-pill border border-trace-subtle bg-control-surface px-2 py-0.5 text-metadata font-medium text-ink-muted">
                Trailing commas accepted
              </span>
              <span aria-hidden="true" className="shrink-0 font-mono text-incidental tabular-nums text-ink-muted">
                {lineCount} {lineCount === 1 ? "line" : "lines"}
              </span>
            </span>
          </div>
          <div className="relative min-w-0">
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-y-0 left-0 w-0.5 transition-colors duration-200 ${error ? "bg-critical" : "bg-proof/55 group-focus-within:bg-proof"}`}
            />
            <textarea
              aria-describedby={error ? "mcp-import-help mcp-import-error" : "mcp-import-help"}
              aria-invalid={error ? true : undefined}
              autoCapitalize="off"
              autoCorrect="off"
              className="block h-[clamp(18rem,36dvh,22rem)] min-h-72 w-full min-w-0 resize-y overflow-auto bg-composer-surface px-4 py-4 pl-5 font-mono text-[13px] leading-6 text-ink caret-proof outline-none placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled [@media(max-height:32rem)]:!h-40 [@media(max-height:32rem)]:!min-h-40"
              disabled={disabled}
              id="mcp-import-document"
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder={'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@example/mcp"] }\n  }\n}\n\nor paste: npx -y @example/mcp@latest'}
              ref={editorRef}
              spellCheck={false}
              value={value}
            />
          </div>
          {error ? (
            <div className="flex items-start gap-2 border-t border-critical/30 bg-critical/[0.07] px-3 py-2.5 text-critical sm:px-4" id="mcp-import-error" role="alert">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 text-xs leading-5">
                <span className="block font-medium">Configuration needs attention</span>
                <span className="block break-words [overflow-wrap:anywhere]">{error}</span>
              </span>
            </div>
          ) : null}
          <div className="flex flex-col gap-3 border-t border-trace-subtle bg-workspace-rail/55 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <span className="inline-flex min-w-0 items-start gap-2 text-metadata leading-5 text-ink-muted" id="mcp-import-help">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-proof" />
              Reviewed before save; pasted commands are never executed, and secrets become write-only fields.
            </span>
            <button className={`${primaryButton} w-full shrink-0 max-sm:!min-h-touch sm:w-auto [@media(max-height:32rem)]:!min-h-touch`} disabled={disabled || !value.trim()} onClick={onNormalize} type="button">
              <ClipboardPaste aria-hidden="true" className="size-3.5" />
              Parse
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
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
  const creating = mode === "create";
  const oauth = form.draft.auth.mode === "oauth";
  const primaryLabel = disabled
    ? creating
      ? oauth ? "Preparing authorization…" : "Starting activation…"
      : "Saving…"
    : creating
      ? oauth ? "Continue to authorization" : "Activate"
      : "Save draft";

  return (
    <section className="grid min-w-0 gap-5 p-4 sm:p-6">
      <div>
        <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Mutable installation draft</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{creating ? "Review MCP server" : "Edit MCP server"}</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          {imported
            ? "The configuration was parsed into a supported source and typed fields. Review it before activation."
            : "Saving invalidates prior draft-test evidence. An active revision keeps running until the next exact tested identity is activated."}
        </p>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label className="min-w-0">
          <span className={fieldLabel}>Display name</span>
          <input autoFocus={imported} className={`${inputClass} mt-1.5`} disabled={disabled} maxLength={120} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} value={form.name} />
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
      {creating ? (
        <section className="border-l-2 border-caution bg-caution/10 px-4 py-3 text-xs leading-5 text-caution">
          <div className="flex items-start gap-2">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              {oauth
                ? "Continue to connect an administrator-owned OAuth identity. AIQSA activates the server after authorization and exact validation complete."
                : "Activation trusts this server as one unit, including every current or future valid tool it exposes. Setup continues in the background after this request is accepted."}
              {form.draft.source.kind !== "remote" ? " Local workloads run in an isolated runtime with unrestricted outbound network access." : ""}
            </p>
          </div>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
        <button className={primaryButton} disabled={disabled || !form.name.trim()} onClick={onSave} type="button">
          {primaryLabel}
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
      const oauth = form.draft.auth.mode === "oauth";
      const created = await controller.actions.create({
        description: form.description,
        draft: form.draft,
        name: form.name.trim(),
        ...(!oauth ? { activate: true } : {}),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (created) {
        if (oauth) actions.openTask("validation");
        else actions.openServer();
      }
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
