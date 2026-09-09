import { compactSelectClass } from "@/components/admin/roles/rolesControls";

export function AdminReasoningSelect({
  disabled, label, model, onChange, value
}: Readonly<{
  disabled: boolean;
  label: string;
  model: Readonly<{ defaultReasoningEffort: string | null; reasoningEfforts: readonly string[] }> | null;
  onChange(effort: string | null): void;
  value: string | null;
}>) {
  const efforts = model?.reasoningEfforts ?? [];
  const unavailable = value !== null && !efforts.includes(value);
  return (
    <select
      aria-label={label}
      className={`${compactSelectClass} xl:w-[14rem]`}
      disabled={disabled || !model || (efforts.length === 0 && value === null)}
      onChange={(event) => onChange(event.currentTarget.value || null)}
      value={value ?? ""}
    >
      <option value="">
        Reasoning: Default{model?.defaultReasoningEffort ? ` (${model.defaultReasoningEffort})` : ""}
      </option>
      {unavailable ? <option disabled value={value}>Reasoning: {value} (unavailable)</option> : null}
      {efforts.map((effort) => <option key={effort} value={effort}>Reasoning: {effort}</option>)}
    </select>
  );
}
