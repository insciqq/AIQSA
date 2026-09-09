"use client";

import { AdminGroupOptions, inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { normalizedRuleValue } from "@/components/admin/adminViewUtils";
import type { AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { fieldLabelClass, helpTextClass, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminAccessRuleKind, AdminGroup } from "@/lib/contracts/admin";
import { useId, useLayoutEffect, useRef, useState } from "react";

function RulesSheetBody({
  controller,
  groups,
  onClose
}: Readonly<{
  controller: AdminAccessRulesController;
  groups: readonly AdminGroup[];
  onClose(): void;
}>) {
  const [kind, setKind] = useState<AdminAccessRuleKind>("email");
  const [value, setValue] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);
  const focusAfterSubmitRef = useRef(false);
  const formId = useId();
  const kindId = useId();
  const valueId = useId();
  const errorId = useId();
  const busy = controller.actionsDisabled || submitting;
  const dirty = value !== "" || groupIds.length > 0 || kind !== "email";
  const preview = normalizedRuleValue(kind, value);

  useLayoutEffect(() => {
    if (!busy && focusAfterSubmitRef.current) {
      focusAfterSubmitRef.current = false;
      valueRef.current?.focus();
    }
  });

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    setError(null);
    if (!preview) {
      setError(kind === "email" ? "Enter an email address." : "Enter a domain.");
      valueRef.current?.focus();
      return;
    }
    setSubmitting(true);
    const result = await controller.actions.createRule({ groupIds, kind, value });
    focusAfterSubmitRef.current = true;
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setValue("");
    setGroupIds([]);
    setKind("email");
  };

  return (
    <AdminSheet
      closeBlocked={busy}
      description="Automatically approve matching verified email addresses and assign these groups."
      footer={(
        <>
          <UiV2Button busy={submitting} disabled={busy} form={formId} tone="primary" type="submit">Add rule</UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Done</UiV2Button>
        </>
      )}
      onClose={requestClose}
      open
      testId="admin-signup-rules-sheet"
      title="Add sign-up rule"
    >
      <div className="flex flex-col gap-6">
        <form
          aria-labelledby={`${formId}-heading`}
          className="flex flex-col gap-4"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h3 className={sectionHeadingClass} id={`${formId}-heading`}>New rule</h3>
          <div>
            <label className={fieldLabelClass} htmlFor={kindId}>Kind</label>
            <select
              className={inputClass}
              disabled={busy}
              id={kindId}
              onChange={(event) => setKind(event.currentTarget.value as AdminAccessRuleKind)}
              value={kind}
            >
              <option value="email">Email</option>
              <option value="domain">Domain</option>
            </select>
          </div>
          <div>
            <label className={fieldLabelClass} htmlFor={valueId}>Value</label>
            <input
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              id={valueId}
              onChange={(event) => {
                setValue(event.currentTarget.value);
                setError(null);
              }}
              placeholder={kind === "email" ? "person@example.com" : "example.com"}
              ref={valueRef}
              spellCheck={false}
              value={value}
            />
            {error ? (
              <p className="mt-1.5 text-xs leading-5 text-critical" id={errorId} role="alert">{error}</p>
            ) : (
              <span className={helpTextClass} data-testid="admin-signup-rule-preview">
                {preview
                  ? <>Matches exactly <span className="font-mono text-ink">{preview}</span>.</>
                  : kind === "email" ? "One exact email address." : "Every email at this domain."}
              </span>
            )}
          </div>
          <AdminGroupOptions groups={[...groups]} label="Groups" onChange={setGroupIds} selected={groupIds} />
        </form>
      </div>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved sign-up rule"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="admin-signup-rules-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          The new rule has not been added yet; what you typed will be lost.
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/** One add-rule draft; the section owns the saved list and deletion. */
export function AdminSignupRulesSheet({
  controller,
  groups,
  onClose,
  open
}: Readonly<{
  controller: AdminAccessRulesController;
  groups: readonly AdminGroup[];
  onClose(): void;
  open: boolean;
}>) {
  if (!open) return null;
  return <RulesSheetBody controller={controller} groups={groups} onClose={onClose} />;
}
