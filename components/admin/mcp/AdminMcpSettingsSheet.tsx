"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { AdminMcpDraftEditor } from "@/components/admin/mcp/AdminMcpDraftEditor";
import {
  blankMcpServerForm,
  editableMcpServerForm,
  normalizeMcpImport,
  requestMcpSharedValues,
  type AdminMcpServerForm
} from "@/components/admin/mcp/adminMcpDraft";
import { fieldLabelClass, helpTextClass, McpNote } from "@/components/admin/mcp/mcpPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { useEffect, useId, useRef, useState } from "react";

export type AdminMcpSettingsSheetMode =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "edit"; server: AdminMcpServer }>;

const errorClass = "rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical";

function SheetBody({
  controller,
  mode,
  onClose,
  onSaved
}: Readonly<{
  controller: AdminMcpController;
  mode: AdminMcpSettingsSheetMode;
  onClose(): void;
  onSaved(serverId: string): void;
}>) {
  const creating = mode.kind === "create";
  const [stage, setStage] = useState<"form" | "import">(creating ? "import" : "form");
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const [form, setForm] = useState<AdminMcpServerForm>(() =>
    mode.kind === "edit" ? editableMcpServerForm(mode.server) : blankMcpServerForm());
  const [baseline, setBaseline] = useState(() => JSON.stringify(form));
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const importId = useId();
  const importHelpId = useId();
  const importErrorId = useId();
  const errorId = useId();
  const importRef = useRef<HTMLTextAreaElement>(null);
  const busy = controller.state.busy || saving;
  const oauth = form.draft.auth.mode === "oauth";
  const local = form.draft.source.kind !== "remote";
  const dirty = stage === "import" ? importValue.length > 0 : JSON.stringify(form) !== baseline;
  const canSave = !busy && form.name.trim() !== "";

  useEffect(() => {
    if (importError) importRef.current?.focus();
  }, [importError]);

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const parse = () => {
    try {
      const normalized = normalizeMcpImport(importValue);
      setForm({
        description: normalized.description,
        draft: structuredClone(normalized.draft),
        name: normalized.name,
        sharedValues: { ...normalized.sharedValues }
      });
      setImported(true);
      setImportError(null);
      setImportValue("");
      setStage("form");
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "The MCP configuration could not be read.");
    }
  };

  const submit = async () => {
    if (stage === "import") {
      parse();
      return;
    }
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      const sharedValues = requestMcpSharedValues(form);
      if (mode.kind === "create") {
        const result = await controller.actions.create({
          description: form.description,
          draft: form.draft,
          name: form.name.trim(),
          ...(oauth ? {} : { activate: true }),
          ...(sharedValues ? { sharedValues } : {})
        });
        if (result.ok) {
          onSaved(result.server.id);
          return;
        }
        setError(result.message);
        return;
      }
      const result = await controller.actions.save(mode.server.id, {
        description: form.description,
        draft: form.draft,
        expectedUpdatedAt: form.expectedUpdatedAt,
        name: form.name.trim(),
        ...(sharedValues ? { sharedValues } : {})
      });
      if (result.applied) {
        onSaved(mode.server.id);
        return;
      }
      if (result.updatedAt) {
        // The fields were staged but the check failed: keep them, and let the
        // sheet close without asking about edits that are already saved.
        const staged = { ...form, expectedUpdatedAt: result.updatedAt };
        setForm(staged);
        setBaseline(JSON.stringify(staged));
      }
      setError(result.message ?? "The settings could not be applied.");
    } finally {
      setSaving(false);
    }
  };

  const title = creating ? "New server" : "Settings";
  const description = stage === "import"
    ? "Paste what the MCP provider gives you: a direct HTTP URL, one mcpServers JSON entry, or an npx, uvx, pipx, pip install, docker or podman command."
    : creating
      ? imported
        ? "Review the parsed settings before the first check."
        : "Describe the server, its source and the values it needs."
      : `${mode.kind === "edit" ? mode.server.name : ""} · changes apply to new chats once the check passes.`;

  return (
    <AdminSheet
      closeBlocked={busy}
      description={description}
      footer={stage === "import" ? (
        <>
          <UiV2Button disabled={busy || !importValue.trim()} form={formId} icon="braces" tone="primary" type="submit">
            Parse
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={() => setStage("form")} tone="ghost" type="button">
            Configure manually
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          <span className="min-w-0 text-xs leading-5 text-ink-muted">
            Pasted commands are never executed; secrets become write-only fields.
          </span>
        </>
      ) : (
        <>
          <UiV2Button busy={saving} disabled={!canSave} form={formId} tone="primary" type="submit">
            {creating && oauth ? "Save and continue" : "Test & Save"}
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          <span className="min-w-0 text-xs leading-5 text-ink-muted">
            {creating && oauth
              ? "Saves the settings. Connect your account on the server page to check and apply them."
              : "Checks the connection and tools, then applies the settings. A failed check changes nothing."}
          </span>
        </>
      )}
      onClose={requestClose}
      open
      testId="mcp-settings-sheet"
      title={title}
      width="wide"
    >
      <form
        aria-describedby={error ? errorId : undefined}
        className="flex flex-col gap-4"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {stage === "import" ? (
          <div className="flex flex-col gap-2">
            <label className={fieldLabelClass} htmlFor={importId}>Configuration JSON, URL, or install command</label>
            <textarea
              aria-describedby={importError ? `${importHelpId} ${importErrorId}` : importHelpId}
              aria-invalid={importError ? true : undefined}
              autoCapitalize="off"
              autoCorrect="off"
              className={`${inputClass} min-h-56 resize-y py-2 font-mono text-[13px] leading-6`}
              data-testid="mcp-configuration-document"
              disabled={busy}
              id={importId}
              onChange={(event) => {
                setImportValue(event.currentTarget.value);
                setImportError(null);
              }}
              placeholder={'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@example/mcp"] }\n  }\n}\n\nor paste: npx -y @example/mcp@latest'}
              ref={importRef}
              spellCheck={false}
              value={importValue}
            />
            <span className={helpTextClass} id={importHelpId}>
              Trailing commas are accepted. AIQSA reviews the result with you before anything is saved.
            </span>
            {importError ? (
              <p className={errorClass} id={importErrorId} role="alert">{importError}</p>
            ) : null}
          </div>
        ) : (
          <>
            <label className="block min-w-0">
              <span className={fieldLabelClass}>Name</span>
              <input
                autoFocus={imported}
                className={inputClass}
                disabled={busy}
                maxLength={120}
                onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
                required
                value={form.name}
              />
            </label>
            <label className="block min-w-0">
              <span className={fieldLabelClass}>Description</span>
              <textarea
                className={`${inputClass} min-h-20 py-2`}
                disabled={busy}
                maxLength={4000}
                onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
                value={form.description}
              />
              <span className={helpTextClass}>Shown to people next to the server in chat settings.</span>
            </label>
            <AdminMcpDraftEditor
              disabled={busy}
              draft={form.draft}
              onChange={(draft) => setForm({ ...form, draft })}
              onSharedValueChange={(slotKey, value) => setForm({ ...form, sharedValues: { ...form.sharedValues, [slotKey]: value } })}
              sharedValueDraft={form.sharedValues}
              storedSharedValues={mode.kind === "edit" ? mode.server.sharedValues : undefined}
            />
            {creating ? (
              <McpNote tone="warn">
                {oauth
                  ? "After saving, connect your account on the server page; AIQSA then checks the settings and applies them automatically."
                  : "Applying trusts this server as one unit, including every current or future valid tool it exposes."}
                {local ? " Local servers run in an isolated runtime with unrestricted outbound network access." : ""}
              </McpNote>
            ) : null}
            {error ? <p className={errorClass} id={errorId} role="alert">{error}</p> : null}
          </>
        )}
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel={creating ? "Discard the new server" : "Discard unsaved server settings"}
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="mcp-settings-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          Unsaved edits in this form will be lost.
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/**
 * The settings sheet (PRD 5.10): the import step and the full form behind
 * one Test & Save that stages the settings, checks them and applies them
 * as one flow. A failed check keeps the previous configuration in use and
 * shows the reason here with the fields preserved. The same sheet creates a
 * server; there the check runs as the background setup.
 */
export function AdminMcpSettingsSheet({
  controller,
  mode,
  onClose,
  onSaved,
  open
}: Readonly<{
  controller: AdminMcpController;
  mode: AdminMcpSettingsSheetMode;
  onClose(): void;
  onSaved(serverId: string): void;
  open: boolean;
}>) {
  if (!open) return null;
  return <SheetBody controller={controller} mode={mode} onClose={onClose} onSaved={onSaved} />;
}
