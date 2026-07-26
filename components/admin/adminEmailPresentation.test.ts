import type { AdminEmailConfiguration, AdminEmailState } from "@/lib/contracts/email";
import { describe, expect, it } from "vitest";
import { deriveAdminEmailPresentation } from "./adminEmailPresentation";

const configuration: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: "mailer@example.com" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 587,
  transport: "starttls_required"
};

function state(): AdminEmailState {
  return {
    active: {
      activatedAt: "2026-07-23T12:00:00.000Z",
      activatedByUserId: "admin-1",
      configuration,
      enabled: true,
      passwordConfigured: true,
      version: 7
    },
    configurationUpdatedAt: "2026-07-23T12:05:00.000Z",
    configurationUpdatedByUserId: "admin-1",
    draft: {
      configuration: { ...configuration, host: "smtp-next.example.com" },
      passwordConfigured: true,
      test: {
        attemptedAt: "2026-07-23T12:06:00.000Z",
        code: "smtp_connection_failed",
        tested: false,
        version: 8
      },
      version: 8
    },
    health: {
      activeVersion: 7,
      degraded: true,
      lastAcceptedAt: "2026-07-23T12:01:00.000Z",
      lastAttemptAt: "2026-07-23T12:07:00.000Z",
      lastFailureAt: "2026-07-23T12:07:00.000Z",
      lastFailureCode: "smtp_command_timeout"
    }
  };
}

describe("deriveAdminEmailPresentation", () => {
  it("keeps draft, active, and health as independent factual axes", () => {
    const presentation = deriveAdminEmailPresentation(state());

    expect(presentation.draft).toMatchObject({ label: "Needs test", tone: "warning" });
    expect(presentation.active).toMatchObject({ label: "Enabled", tone: "positive" });
    expect(presentation.health).toMatchObject({ label: "Degraded", tone: "critical" });
    expect(presentation.health.detail).toContain("smtp_command_timeout");
  });

  it("accepts test evidence only for the exact current draft version", () => {
    const email = state();
    const stale = {
      ...email,
      draft: {
        ...email.draft,
        test: { ...email.draft.test!, code: "accepted" as const, tested: true, version: 7 }
      }
    };
    expect(deriveAdminEmailPresentation(stale).tested).toBe(false);

    const exact = {
      ...stale,
      draft: { ...stale.draft, test: { ...stale.draft.test!, version: stale.draft.version } }
    };
    expect(deriveAdminEmailPresentation(exact).draft.label).toBe("Tested");
  });
});
