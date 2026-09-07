"use client";

import { adminActionErrorMessage } from "@/components/admin/adminApi";
import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import type { AdminGroupActionTarget, AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import { fieldLabelClass, helpTextClass } from "@/components/admin/users/usersPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import { useEffect, useId, useRef, useState } from "react";

export type AdminGroupNameSheetMode =
  | Readonly<{ kind: "create" }>
  | Readonly<{ group: AdminGroupActionTarget; kind: "rename" }>;

function SheetBody({
  controller,
  mode,
  onClose,
  onSaved
}: Readonly<{
  controller: AdminGroupsController;
  mode: AdminGroupNameSheetMode;
  onClose(): void;
  onSaved(groupId: string | null): void;
}>) {
  const baseline = mode.kind === "rename" ? mode.group.name : "";
  const [name, setName] = useState(baseline);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const inputId = useId();
  const errorId = useId();
  const busy = controller.actionsDisabled || submitting;
  const dirty = name !== baseline;
  const rename = mode.kind === "rename";

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  // The field is disabled while saving, so focus returns once the failure is shown.
  useEffect(() => {
    if (error && !busy) inputRef.current?.focus();
  }, [busy, error]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(adminActionErrorMessage("group_required"));
      return;
    }
    setSubmitting(true);
    const result = mode.kind === "rename"
      ? await controller.actions.rename(mode.group, name)
      : await controller.actions.create(name);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved(result.groupId);
  };

  return (
    <AdminSheet
      closeBlocked={busy}
      description={rename
        ? "Members keep their access; only the name changes."
        : "Create the group first, then add people and choose what they can use."}
      footer={(
        <>
          <UiV2Button busy={submitting} disabled={busy} form={formId} tone="primary" type="submit">
            {rename ? "Save" : "Create"}
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
        </>
      )}
      onClose={requestClose}
      open
      testId="admin-group-name-sheet"
      title={rename ? "Rename group" : "New group"}
    >
      <form
        className="flex flex-col gap-4"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className={fieldLabelClass} htmlFor={inputId}>Group name</label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            className={inputClass}
            disabled={busy}
            id={inputId}
            maxLength={80}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
            placeholder="Profile · Research"
            ref={inputRef}
            value={name}
          />
          {error ? (
            <p className="mt-1.5 text-xs leading-5 text-critical" id={errorId} role="alert">{error}</p>
          ) : (
            <p className={helpTextClass}>Shown to administrators only.</p>
          )}
        </div>
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved group name"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="admin-group-name-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          {rename ? "The group keeps its current name." : "The group has not been created yet; what you typed will be lost."}
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/**
 * The small name sheet shared by `New group` and `Rename` (PRD 5.9): one
 * field, one Save, the failure inline. The discard dialog lives inside the
 * sheet because the page behind an open sheet is inert.
 */
export function AdminGroupNameSheet({
  controller,
  mode,
  onClose,
  onSaved,
  open
}: Readonly<{
  controller: AdminGroupsController;
  mode: AdminGroupNameSheetMode;
  onClose(): void;
  onSaved(groupId: string | null): void;
  open: boolean;
}>) {
  if (!open) return null;
  return <SheetBody controller={controller} mode={mode} onClose={onClose} onSaved={onSaved} />;
}
