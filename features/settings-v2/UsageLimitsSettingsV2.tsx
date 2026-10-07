"use client";

import { usageLimitsSettingsView } from "@/components/app-shell/usageLimitStatus";
import { useUsageLimitStatus, type UsageLimitStatusLoader } from "@/components/app-shell/useUsageLimitStatus";
import { useId } from "react";

/**
 * Settings → Account: the user's own monthly budget and message allowance.
 * Shown only when a limit applies or the shared cap is reached; nothing while
 * loading, and a quiet line instead of numbers when the status is unavailable.
 * The panel remounts per account, so one scope key suffices.
 */
export function UsageLimitsSettingsV2({ load }: Readonly<{ load?: UsageLimitStatusLoader }>) {
  const { refresh, state } = useUsageLimitStatus({ load, scopeKey: "settings-account" });
  const titleId = useId();
  if (state.kind === "loading") return null;
  if (state.kind === "failed") {
    return (
      <p className="v2-settings-usage-unavailable" data-testid="settings-usage-limits-unavailable">
        <span>Usage limits are unavailable right now.</span>
        <button className="v2-focusable" type="button" onClick={refresh}>Retry</button>
      </p>
    );
  }
  const view = usageLimitsSettingsView(state.status, { now: new Date() });
  if (!view) return null;
  return (
    <section aria-labelledby={titleId} className="v2-settings-usage" data-testid="settings-usage-limits">
      <div className="v2-settings-row-copy">
        <span className="v2-settings-row-title" id={titleId}>Usage limits</span>
        <span className="v2-settings-row-description">Set by your administrator.</span>
      </div>
      {view.installation ? <p className="v2-settings-usage-note" data-tone="critical">{view.installation}</p> : null}
      {view.budget ? (
        <div className="v2-settings-usage-item">
          <div className="v2-settings-usage-line">
            <span>Monthly budget</span>
            <strong data-tone={view.budget.tone}>{view.budget.text}</strong>
          </div>
          <div
            aria-label="Monthly budget used"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={view.budget.percent}
            aria-valuetext={`${view.budget.percent}% used`}
            className="v2-settings-usage-meter"
            data-tone={view.budget.tone}
            role="meter"
          >
            <span style={{ width: `${view.budget.percent}%` }} />
          </div>
          <small>{view.budget.resets}</small>
        </div>
      ) : null}
      {view.messages ? (
        <div className="v2-settings-usage-line">
          <span>Messages</span>
          <strong data-tone={view.messages.tone}>{view.messages.text}</strong>
        </div>
      ) : null}
    </section>
  );
}
