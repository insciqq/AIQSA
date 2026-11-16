"use client";

import { UiV2Switch } from "@/components/ui-v2";
import type { ReactNode } from "react";

/*
 * The row primitives of Settings sections. The sections themselves live in
 * the Settings surface (`features/workspace-v2/WorkspaceWelcomeV2.tsx`).
 */

/** One Settings row: title, subtitle, and the control on the right (PRD §4.9). */
export function SettingsRowV2({
  children,
  description,
  testId,
  title,
  tone
}: Readonly<{
  children?: ReactNode;
  description?: ReactNode;
  testId?: string;
  title: ReactNode;
  tone?: "danger";
}>) {
  return (
    <div className="v2-settings-row" data-testid={testId} data-tone={tone}>
      <div className="v2-settings-row-copy">
        <span className="v2-settings-row-title">{title}</span>
        {description ? <span className="v2-settings-row-description">{description}</span> : null}
      </div>
      {children ? <div className="v2-settings-row-control">{children}</div> : null}
    </div>
  );
}

/** Group label above a run of rows ("Danger zone"). */
export function SettingsGroupLabelV2({ children, tone }: Readonly<{ children: ReactNode; tone?: "danger" }>) {
  return <p className="v2-settings-group-label" data-tone={tone}>{children}</p>;
}

/** The Settings row switch: the shared `UiV2Switch` (role="switch"). */
export function SettingsSwitchV2({
  checked,
  disabled = false,
  label,
  onChange
}: Readonly<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(next: boolean): void;
}>) {
  return <UiV2Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />;
}
