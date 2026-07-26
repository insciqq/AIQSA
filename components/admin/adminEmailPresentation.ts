import type { AdminEmailState } from "@/lib/contracts/email";

export type AdminEmailAxis = Readonly<{
  detail: string;
  label: string;
  tone: "critical" | "inactive" | "muted" | "positive" | "proof" | "warning";
}>;

export type AdminEmailPresentation = Readonly<{
  active: AdminEmailAxis;
  draft: AdminEmailAxis;
  health: AdminEmailAxis;
  tested: boolean;
}>;

export function deriveAdminEmailPresentation(email: AdminEmailState): AdminEmailPresentation {
  const tested = email.draft.test?.tested === true && email.draft.test.version === email.draft.version;

  const draft: AdminEmailAxis = !email.draft.configuration
    ? {
        detail: `Draft version ${email.draft.version} has no SMTP configuration.`,
        label: "Not configured",
        tone: "muted"
      }
    : tested
      ? {
          detail: `Draft version ${email.draft.version} passed an exact SMTP test.`,
          label: "Tested",
          tone: "proof"
        }
      : {
          detail: email.draft.test
            ? `Draft version ${email.draft.version} needs another test; last result: ${email.draft.test.code}.`
            : `Draft version ${email.draft.version} has not been tested.`,
          label: "Needs test",
          tone: "warning"
        };

  const active: AdminEmailAxis = !email.active.configuration
    ? {
        detail: `Active version ${email.active.version} has no SMTP configuration.`,
        label: "Not active",
        tone: "muted"
      }
    : email.active.enabled
      ? {
          detail: `Active version ${email.active.version} is loaded for outgoing email.`,
          label: "Enabled",
          tone: "positive"
        }
      : {
          detail: `Active version ${email.active.version} is retained but delivery is disabled.`,
          label: "Disabled",
          tone: "inactive"
        };

  const health: AdminEmailAxis = !email.active.configuration
    ? {
        detail: "Health starts after a tested draft is activated.",
        label: "No active delivery",
        tone: "muted"
      }
    : email.health.degraded
      ? {
          detail: email.health.lastFailureCode
            ? `Active version ${email.health.activeVersion ?? email.active.version} reported ${email.health.lastFailureCode}.`
            : `Active version ${email.health.activeVersion ?? email.active.version} is degraded.`,
          label: "Degraded",
          tone: "critical"
        }
      : email.active.enabled
        ? {
            detail: `No degradation is reported for active version ${email.health.activeVersion ?? email.active.version}.`,
            label: "No degradation reported",
            tone: "positive"
          }
        : {
            detail: "Delivery is disabled, so there is no active send health to infer.",
            label: "Inactive",
            tone: "muted"
          };

  return { active, draft, health, tested };
}
