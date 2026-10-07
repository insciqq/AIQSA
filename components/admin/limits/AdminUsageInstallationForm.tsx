"use client";

import { usageLimitsErrorMessage } from "@/components/admin/limits/adminUsageLimitsApi";
import { UsageLimitInput, useFocusFirstInvalid } from "@/components/admin/limits/UsageLimitControls";
import type { AdminUsageLimitsController } from "@/components/admin/limits/useAdminUsageLimits";
import {
  draftFromValues,
  formatLimitValue,
  parseLimitDraft,
  parseUsdField,
  sameDraft,
  type UsageLimitDraft,
  type UsageLimitField
} from "@/components/admin/limits/usageLimitsView";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { UiV2Button } from "@/components/ui-v2";
import { formatMicrosAsUsdInput, type UsageInstallationLimits } from "@/lib/contracts/usageLimits";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";

type InstallationField = UsageLimitField | "monthlyCapMicros";
type InstallationDraft = UsageLimitDraft & Readonly<{ monthlyCapMicros: string }>;

function installationDraft(installation: UsageInstallationLimits): InstallationDraft {
  return {
    ...draftFromValues(installation),
    monthlyCapMicros: installation.monthlyCapMicros === null ? "" : formatMicrosAsUsdInput(installation.monthlyCapMicros)
  };
}

const perUserFields: readonly Readonly<{ field: UsageLimitField; kind: "count" | "usd"; label: string }>[] = [
  { field: "monthlyBudgetMicros", kind: "usd", label: "Monthly budget per user" },
  { field: "messagesPerHour", kind: "count", label: "Messages per hour" },
  { field: "messagesPerDay", kind: "count", label: "Messages per day" }
];

function savedText(installation: UsageInstallationLimits, field: InstallationField): string {
  const value = field === "monthlyCapMicros"
    ? (installation.monthlyCapMicros === null ? null : formatLimitValue("monthlyBudgetMicros", installation.monthlyCapMicros))
    : formatLimitValue(field, installation[field]);
  return `Saved: ${value ?? "not set"}`;
}

/**
 * The installation singleton: the pooled cap and the per-user defaults, saved
 * together against the version the draft started from. A background refresh
 * never replaces what the administrator is typing, and never advances that
 * version: a change saved meanwhile by someone else is a visible conflict,
 * not a silent overwrite. After a conflict the shown saved values are the
 * basis of the next save.
 */
export function AdminUsageInstallationForm({
  controller,
  installation,
  reportNotice
}: Readonly<{
  controller: AdminUsageLimitsController;
  installation: UsageInstallationLimits;
  reportNotice(message: string): void;
}>) {
  const saved = useMemo(() => installationDraft(installation), [installation]);
  const [draft, setDraft] = useState<InstallationDraft | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [errors, setErrors] = useState<Partial<Record<InstallationField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);
  const idPrefix = useId();
  const current = draft ?? saved;
  const dirty = draft !== null && (draft.monthlyCapMicros !== saved.monthlyCapMicros || !sameDraft(draft, saved));
  const busy = controller.busy;

  const change = (field: InstallationField, value: string) => {
    if (draft === null) setDraftVersion(installation.version);
    setDraft({ ...current, [field]: value });
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !dirty) return;
    const cap = parseUsdField(current.monthlyCapMicros);
    const parsed = parseLimitDraft(current);
    const nextErrors = { ...parsed.errors, ...("error" in cap ? { monthlyCapMicros: cap.error } : {}) };
    setErrors(nextErrors);
    if (!parsed.values || "error" in cap) {
      focusInvalid();
      return;
    }
    setFormError(null);
    setSaving(true);
    const result = await controller.saveInstallation({
      ...parsed.values,
      expectedVersion: conflict ? installation.version : draftVersion ?? installation.version,
      monthlyCapMicros: cap.value
    });
    setSaving(false);
    if (result.ok) {
      setDraft(null);
      setDraftVersion(null);
      setConflict(false);
      reportNotice("Limits saved. They apply to new messages.");
      return;
    }
    setFormError(usageLimitsErrorMessage(result.error));
    if (result.error === "usage_limits_stale") {
      setConflict(true);
      void controller.refresh();
    }
  };

  const field = (name: InstallationField, kind: "count" | "usd", label: string, help: string) => (
    <UsageLimitInput
      disabled={busy}
      error={errors[name]}
      help={conflict ? `${savedText(installation, name)}. ${help}` : help}
      id={`${idPrefix}-${name}`}
      key={name}
      kind={kind}
      label={label}
      onChange={(value) => change(name, value)}
      placeholder={name === "monthlyCapMicros" ? "No cap" : "No limit"}
      value={current[name]}
    />
  );

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className={`${cardClass} p-5`}>
      <h2 className={sectionHeadingClass} id={`${idPrefix}-heading`}>Limits for everyone</h2>
      <form className="mt-4 flex flex-col gap-5" noValidate onSubmit={(event) => void submit(event)} ref={formRef}>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          {field(
            "monthlyCapMicros",
            "usd",
            "Monthly cap for everyone",
            "Known cost of all users together this month. Leave empty for no cap."
          )}
        </div>
        <fieldset className="min-w-0 border-t border-trace-subtle pt-4">
          <legend className="sr-only">Defaults per user</legend>
          <p className="text-sm font-medium text-ink" aria-hidden="true">Defaults per user</p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
            Apply to users without a group allowance or an override for that limit. Leave a field empty for no limit.
          </p>
          <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-3">
            {perUserFields.map(({ field: name, kind, label }) => field(name, kind, label, kind === "usd"
              ? "Known cost per user this month."
              : name === "messagesPerHour" ? "Messages in the last 60 minutes." : "Messages in the last 24 hours."))}
          </div>
        </fieldset>
        {formError ? <p className="text-xs leading-5 text-critical" role="alert">{formError}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <UiV2Button busy={saving} disabled={busy || !dirty} tone="primary" type="submit">Save limits</UiV2Button>
          {dirty ? (
            <UiV2Button
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setErrors({});
                setFormError(null);
                setConflict(false);
              }}
              tone="ghost"
              type="button"
            >
              Discard changes
            </UiV2Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
