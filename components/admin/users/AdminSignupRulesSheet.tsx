"use client";

import { AdminGroupOptions, inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { groupLabel, normalizedRuleValue } from "@/components/admin/adminViewUtils";
import type { AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { fieldLabelClass, helpTextClass, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import type { AdminAccessRuleKind, AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { Globe2, Mail } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

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
  const [deleting, setDeleting] = useState<AdminAccessRuleRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const focusValueAfterDeleteRef = useRef(false);
  const valueRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const kindId = useId();
  const valueId = useId();
  const errorId = useId();
  const listId = useId();
  const busy = controller.actionsDisabled || submitting || deletingBusy;
  const dirty = value !== "" || groupIds.length > 0 || kind !== "email";
  const preview = normalizedRuleValue(kind, value);

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
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      valueRef.current?.focus();
      return;
    }
    setValue("");
    setGroupIds([]);
    setKind("email");
    valueRef.current?.focus();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    const ok = await controller.actions.deleteRule(deleting);
    setDeletingBusy(false);
    setDeleting(null);
    // The rule's own Delete control is gone with the rule; keep focus inside the sheet.
    if (ok) focusValueAfterDeleteRef.current = true;
  };

  useEffect(() => {
    if (!focusValueAfterDeleteRef.current || deleting || busy) return;
    focusValueAfterDeleteRef.current = false;
    valueRef.current?.focus();
  }, [busy, deleting]);

  return (
    <AdminSheet
      closeBlocked={busy}
      description="Sign-ups from a matching email or domain are approved on their own and get these groups."
      footer={(
        <>
          <UiV2Button busy={submitting} disabled={busy} form={formId} tone="primary" type="submit">Add rule</UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Done</UiV2Button>
        </>
      )}
      onClose={requestClose}
      open
      testId="admin-signup-rules-sheet"
      title="Sign-up rules"
    >
      <div className="flex flex-col gap-6">
        <section aria-labelledby={listId} className="flex flex-col gap-2.5">
          <h3 className={sectionHeadingClass} id={listId}>Rules · {controller.rules.length}</h3>
          {controller.rules.length ? (
            <ul aria-label="Sign-up rules" className="divide-y divide-trace-subtle rounded-[10px] border border-trace-subtle">
              {controller.rules.map((rule) => {
                const Icon = rule.kind === "email" ? Mail : Globe2;
                return (
                  <li
                    className={`flex min-w-0 items-center gap-3 px-3 py-2.5 ${rule.enabled ? "" : "opacity-65"}`}
                    data-testid="admin-signup-rule"
                    key={rule.id}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{rule.value}</p>
                      <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
                        {rule.kind === "email" ? "Email" : "Domain"} · {groupLabel(rule.defaultGroups)}
                        {rule.enabled ? "" : " · off"}
                      </p>
                    </div>
                    <UiV2IconButton
                      disabled={busy}
                      icon="trash"
                      label={`Delete rule ${rule.value}`}
                      onClick={() => setDeleting(rule)}
                      tooltip="Delete"
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={helpTextClass} role="status">No rules yet. Every sign-up waits for approval.</p>
          )}
        </section>

        <form
          aria-labelledby={`${formId}-heading`}
          className="flex flex-col gap-4 border-t border-trace-subtle pt-5"
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
      {deleting ? (
        <ConfirmationDialog
          busy={deletingBusy}
          confirmLabel="Delete rule"
          dialogLabel={`Delete sign-up rule ${deleting.value}`}
          icon="trash"
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
          testId="admin-confirm-delete-access-rule"
          title="Delete sign-up rule?"
        >
          {`Delete the ${deleting.kind} rule for ${deleting.value}? Future matching sign-ups will wait for approval again.`}
        </ConfirmationDialog>
      ) : null}
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

/**
 * Sign-up rules sheet (PRD 5.8): the current email/domain rules with their
 * groups, one add form and delete with confirmation. Both dialogs render
 * inside the sheet because the page behind an open sheet is inert.
 */
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
