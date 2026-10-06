"use client";

import { usageLimitsErrorMessage } from "@/components/admin/limits/adminUsageLimitsApi";
import { UsageLimitInput, useFocusFirstInvalid } from "@/components/admin/limits/UsageLimitControls";
import type { AdminUsageLimitsController, AdminUsageLimitsOutcome } from "@/components/admin/limits/useAdminUsageLimits";
import {
  draftFromValues,
  formatLimitValue,
  parseLimitDraft,
  sameDraft,
  USAGE_LIMIT_FIELDS,
  type UsageLimitDraft,
  type UsageLimitField,
  type UsageLimitFieldErrors
} from "@/components/admin/limits/usageLimitsView";
import { helpTextClass } from "@/components/admin/users/usersPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import type { AdminUsageLimitGroupRow, AdminUsageLimitUserRow, UsageLimitValues } from "@/lib/contracts/usageLimits";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

const UNSET: UsageLimitValues = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };

const fieldCopy: Readonly<Record<UsageLimitField, Readonly<{ kind: "count" | "usd"; label: string }>>> = {
  messagesPerDay: { kind: "count", label: "Messages per day" },
  messagesPerHour: { kind: "count", label: "Messages per hour" },
  monthlyBudgetMicros: { kind: "usd", label: "Monthly budget" }
};

type Notify = (message: string) => void;

/** Shared shell: Save, Cancel, optional extra actions, and a discard check for unsaved edits. */
function LimitsSheet({
  busy,
  children,
  description,
  dirty,
  extraActions,
  formId,
  onClose,
  onSubmit,
  saving,
  testId,
  title
}: Readonly<{
  busy: boolean;
  children: ReactNode;
  description: string;
  dirty: boolean;
  extraActions?: ReactNode;
  formId: string;
  onClose(): void;
  onSubmit(): void;
  saving: boolean;
  testId: string;
  title: string;
}>) {
  const [discarding, setDiscarding] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };
  return (
    <UiV2Sheet
      closeBlocked={busy}
      description={description}
      footer={(
        <>
          <UiV2Button busy={saving} disabled={busy} form={formId} tone="primary" type="submit">Save</UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          {extraActions}
        </>
      )}
      onClose={requestClose}
      open
      testId={testId}
      title={title}
    >
      <form
        className="flex flex-col gap-4"
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        {children}
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved limits"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId={`${testId}-discard`}
          title="Discard unsaved changes?"
          tone="warning"
        >
          The saved limits stay as they are.
        </ConfirmationDialog>
      ) : null}
    </UiV2Sheet>
  );
}

function LimitFields({
  disabled,
  draft,
  errors,
  help,
  idPrefix,
  onChange
}: Readonly<{
  disabled: boolean;
  draft: UsageLimitDraft;
  errors: UsageLimitFieldErrors;
  help(field: UsageLimitField): string;
  idPrefix: string;
  onChange(field: UsageLimitField, value: string): void;
}>) {
  return (
    <>
      {USAGE_LIMIT_FIELDS.map((field) => (
        <UsageLimitInput
          disabled={disabled}
          error={errors[field]}
          help={help(field)}
          id={`${idPrefix}-${field}`}
          key={field}
          kind={fieldCopy[field].kind}
          label={fieldCopy[field].label}
          onChange={(value) => onChange(field, value)}
          placeholder="Not set"
          value={draft[field]}
        />
      ))}
    </>
  );
}

/** A group's per-member allowance; leaving every field empty removes it. */
export function AdminUsageGroupLimitsSheet({
  controller,
  group,
  onClose,
  reportNotice
}: Readonly<{
  controller: AdminUsageLimitsController;
  group: AdminUsageLimitGroupRow;
  onClose(): void;
  reportNotice: Notify;
}>) {
  const baseline = useMemo(() => draftFromValues(group), [group]);
  const [draft, setDraft] = useState<UsageLimitDraft>(baseline);
  const [errors, setErrors] = useState<UsageLimitFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  const focusInvalid = useFocusFirstInvalid(scope);
  const idPrefix = useId();
  const busy = controller.busy;

  const submit = async () => {
    const parsed = parseLimitDraft(draft);
    setErrors(parsed.errors);
    if (!parsed.values) {
      focusInvalid();
      return;
    }
    setFormError(null);
    setSaving(true);
    const result = await controller.saveGroup(group.groupId, parsed.values);
    setSaving(false);
    if (!result.ok) {
      setFormError(usageLimitsErrorMessage(result.error));
      return;
    }
    const cleared = USAGE_LIMIT_FIELDS.every((field) => parsed.values![field] === null);
    reportNotice(cleared ? `${group.name} no longer has an allowance.` : `Allowance for ${group.name} saved.`);
    onClose();
  };

  return (
    <LimitsSheet
      busy={busy}
      description="Each member gets this allowance. Someone in several groups gets the most generous value of each limit; empty fields don't take part."
      dirty={!sameDraft(draft, baseline)}
      formId={`${idPrefix}-form`}
      onClose={onClose}
      onSubmit={() => void submit()}
      saving={saving}
      testId="admin-usage-group-limits-sheet"
      title={`Allowance for ${group.name}`}
    >
      <div className="flex flex-col gap-4" ref={scope}>
        <p className={helpTextClass}>
          {group.memberCount === 1 ? "1 member" : `${group.memberCount.toLocaleString("en-US")} members`}. Leave every field empty to remove the allowance.
        </p>
        <LimitFields
          disabled={busy}
          draft={draft}
          errors={errors}
          help={(field) => field === "monthlyBudgetMicros" ? "Known cost per member this month, in US dollars." : "Leave empty to let other groups or the default decide."}
          idPrefix={idPrefix}
          onChange={(field, value) => {
            setDraft((previous) => ({ ...previous, [field]: value }));
            setErrors((previous) => ({ ...previous, [field]: undefined }));
          }}
        />
        {formError ? <p className="text-xs leading-5 text-critical" role="alert">{formError}</p> : null}
      </div>
    </LimitsSheet>
  );
}

function inheritedHelp(user: AdminUsageLimitUserRow, field: UsageLimitField): string {
  const limit = user.effective[field];
  // Only a field without its own override shows what it inherits right now.
  if (user.effective.exempt || (user.override !== null && user.override[field] !== null)) {
    return "Leave empty to inherit from groups or the default.";
  }
  const value = formatLimitValue(field, limit.value);
  if (limit.source === null || value === null) return "Leave empty for no limit, as now.";
  if (limit.source.kind === "group") return `Leave empty to inherit ${value} from ${limit.source.name}.`;
  return `Leave empty to inherit the default, ${value}.`;
}

/** One user's override: exemption and three inherit-or-value fields. */
export function AdminUsageUserLimitsSheet({
  controller,
  onClose,
  reportNotice,
  user
}: Readonly<{
  controller: AdminUsageLimitsController;
  onClose(): void;
  reportNotice: Notify;
  user: AdminUsageLimitUserRow;
}>) {
  const baseline = useMemo(() => draftFromValues(user.override ?? UNSET), [user.override]);
  const baselineExempt = user.override?.exempt ?? false;
  const [draft, setDraft] = useState<UsageLimitDraft>(baseline);
  const [exempt, setExempt] = useState(baselineExempt);
  const [errors, setErrors] = useState<UsageLimitFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"remove" | "save" | null>(null);
  const scope = useRef<HTMLDivElement>(null);
  const focusInvalid = useFocusFirstInvalid(scope);
  const idPrefix = useId();
  const busy = controller.busy;
  const name = user.displayName;

  const finish = (result: AdminUsageLimitsOutcome, notice: string) => {
    setSaving(null);
    if (!result.ok) {
      setFormError(usageLimitsErrorMessage(result.error));
      return;
    }
    reportNotice(notice);
    onClose();
  };

  const submit = async () => {
    const parsed = parseLimitDraft(draft);
    setErrors(parsed.errors);
    if (!parsed.values) {
      focusInvalid();
      return;
    }
    setFormError(null);
    setSaving("save");
    const cleared = !exempt && USAGE_LIMIT_FIELDS.every((field) => parsed.values![field] === null);
    finish(
      await controller.saveUser(user.userId, { ...parsed.values, exempt }),
      cleared ? `${name} now follows group and default limits.` : `Limits for ${name} saved.`
    );
  };

  const remove = async () => {
    setFormError(null);
    setSaving("remove");
    finish(await controller.removeUser(user.userId), `Override removed. ${name} now follows group and default limits.`);
  };

  return (
    <LimitsSheet
      busy={busy}
      description="An override replaces this user's inherited limits field by field. The monthly cap for everyone still applies."
      dirty={exempt !== baselineExempt || !sameDraft(draft, baseline)}
      extraActions={user.override ? (
        <UiV2Button busy={saving === "remove"} className="sm:ml-auto" disabled={busy} onClick={() => void remove()} tone="ghost" type="button">
          Remove override
        </UiV2Button>
      ) : null}
      formId={`${idPrefix}-form`}
      onClose={onClose}
      onSubmit={() => void submit()}
      saving={saving === "save"}
      testId="admin-usage-user-limits-sheet"
      title={`Limits for ${name}`}
    >
      <div className="flex flex-col gap-4" ref={scope}>
        {user.email ? <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{user.email}</p> : null}
        <div className="flex min-w-0 items-start justify-between gap-4 rounded-control border border-trace-subtle px-3 py-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">Exempt from per-user limits</span>
            <span className="mt-1 block text-xs leading-5 text-ink-muted">
              No budget or message limits for this user. The monthly cap for everyone still applies.
            </span>
          </span>
          <UiV2Switch
            checked={exempt}
            className="shrink-0"
            disabled={busy}
            label="Exempt from per-user limits"
            onChange={setExempt}
          />
        </div>
        <LimitFields
          disabled={busy}
          draft={draft}
          errors={errors}
          help={(field) => exempt ? "Ignored while the user is exempt; kept for later." : inheritedHelp(user, field)}
          idPrefix={idPrefix}
          onChange={(field, value) => {
            setDraft((previous) => ({ ...previous, [field]: value }));
            setErrors((previous) => ({ ...previous, [field]: undefined }));
          }}
        />
        {formError ? <p className="text-xs leading-5 text-critical" role="alert">{formError}</p> : null}
      </div>
    </LimitsSheet>
  );
}
