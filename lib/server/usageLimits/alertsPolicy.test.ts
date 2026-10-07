import { describe, expect, it } from "vitest";
import {
  dueUsageLimitAlerts,
  installationAlertContent,
  USAGE_LIMIT_ALERT_USERS_PER_CHECK,
  usersAlertContent
} from "./alertsPolicy";
import { usageLimitsFixture, usageUserRow } from "./alertsTestFixtures";

const appBaseUrl = "https://aiqsa.example";
const resetsAt = new Date("2026-11-01T00:00:00.000Z");

describe("due usage limit alerts", () => {
  it("raises the pooled cap alert at 80% and at 100%, never for a missing or zero cap", () => {
    const cap = 100_000_000;
    const kind = (input: { cap: number | null; spent: number }) => dueUsageLimitAlerts(usageLimitsFixture(input)).installation?.kind ?? null;
    expect(kind({ cap, spent: 79_999_999 })).toBeNull();
    expect(kind({ cap, spent: 80_000_000 })).toBe("installation_cap_near");
    expect(kind({ cap, spent: 99_999_999 })).toBe("installation_cap_near");
    expect(kind({ cap, spent: 100_000_000 })).toBe("installation_cap_reached");
    expect(kind({ cap, spent: 250_000_000 })).toBe("installation_cap_reached");
    expect(kind({ cap: null, spent: 250_000_000 })).toBeNull();
    // A zero cap blocks everyone on purpose; it needs no alert.
    expect(kind({ cap: 0, spent: 0 })).toBeNull();
    expect(dueUsageLimitAlerts(usageLimitsFixture({ cap, spent: 85_000_000 })).installation)
      .toEqual({ capMicros: cap, kind: "installation_cap_near", spentMicros: 85_000_000 });
  });

  it("lists active users at a budget above zero, with the month of the status", () => {
    const due = dueUsageLimitAlerts(usageLimitsFixture({ users: [
      usageUserRow({ budget: 5_000_000, displayName: "Ada", spent: 5_000_000, userId: "at" }),
      usageUserRow({ budget: 5_000_000, spent: 7_500_000, userId: "over" }),
      usageUserRow({ budget: 5_000_000, spent: 4_999_999, userId: "below" }),
      usageUserRow({ budget: 0, spent: 1, userId: "zero" }),
      usageUserRow({ budget: null, spent: 9_000_000, userId: "unlimited" }),
      usageUserRow({ budget: 1_000_000, spent: 2_000_000, status: "disabled", userId: "disabled" })
    ] }));
    expect(due.users).toEqual([
      { budgetMicros: 5_000_000, displayName: "Ada", spentMicros: 5_000_000, userId: "at" },
      { budgetMicros: 5_000_000, displayName: "Person over", spentMicros: 7_500_000, userId: "over" }
    ]);
    expect(due.periodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(due.resetsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("lists every user at budget; the claim bounds a check", () => {
    const users = Array.from({ length: USAGE_LIMIT_ALERT_USERS_PER_CHECK + 5 }, (_, index) =>
      usageUserRow({ budget: 1_000_000, spent: 1_000_000, userId: `user-${index}` }));
    expect(dueUsageLimitAlerts(usageLimitsFixture({ users })).users).toHaveLength(USAGE_LIMIT_ALERT_USERS_PER_CHECK + 5);
  });
});

describe("usage limit alert content", () => {
  it("states the pooled cap facts with the reset date and the Budgets & limits link", () => {
    const near = installationAlertContent({ capMicros: 100_000_000, kind: "installation_cap_near", spentMicros: 82_104_523 },
      { appBaseUrl, resetsAt });
    expect(near.email.subject).toBe("AIQSA monthly cap almost used");
    expect(near.email.text).toContain("The monthly cap for everyone in AIQSA is 82% used.");
    expect(near.email.text).toContain("Spent this month: $82.10 of the $100.00 cap.");
    expect(near.email.text).toContain("The cap resets on November 1, 2026 (UTC).");
    expect(near.email.text).toContain("https://aiqsa.example/admin?section=limits");
    expect(near.push).toEqual({
      body: "82% used: $82.10 of the $100.00 cap. Resets on November 1, 2026 (UTC).",
      tag: "aiqsa-usage-cap",
      title: "Monthly cap almost used",
      url: "/admin?section=limits",
      v: 1
    });

    const reached = installationAlertContent({ capMicros: 12_345_678, kind: "installation_cap_reached", spentMicros: 12_400_000 },
      { appBaseUrl, resetsAt });
    expect(reached.email.subject).toBe("AIQSA monthly cap reached");
    expect(reached.email.text).toContain("Spent this month: $12.40 of the $12.345678 cap.");
    expect(reached.email.text).toContain("New messages are refused for everyone until the cap resets on November 1, 2026 (UTC) or you raise it.");
    expect(reached.push.title).toBe("Monthly cap reached");
    // Subjects are plain ASCII for the SMTP header.
    for (const content of [near, reached]) expect(content.email.subject).toMatch(/^[\x20-\x7e]+$/u);
  });

  it("batches users into one message with only their display names and amounts", () => {
    const content = usersAlertContent([
      { budgetMicros: 10_000_000, displayName: "Ada\nLovelace", spentMicros: 10_200_000, userId: "user-1" },
      { budgetMicros: 5_000_000, displayName: "Grace", spentMicros: 5_000_000, userId: "user-2" }
    ], { appBaseUrl, resetsAt });
    expect(content.email.subject).toBe("AIQSA users reached their monthly budget");
    expect(content.email.text).toContain("These 2 people reached their monthly budget");
    expect(content.email.text).toContain("- Ada Lovelace: $10.20 of $10.00\n- Grace: $5.00 of $5.00");
    expect(content.email.text).not.toContain("user-1");
    expect(content.email.text).not.toContain("@");
    expect(content.push).toMatchObject({ tag: "aiqsa-usage-budgets", title: "2 users reached their monthly budget", url: "/admin?section=limits" });
    expect(content.push.body).toBe("Ada Lovelace, Grace · no new messages until November 1, 2026 (UTC)");

    const one = usersAlertContent([{ budgetMicros: 1_000_000, displayName: " ", spentMicros: 1_000_000, userId: "user-3" }],
      { appBaseUrl, resetsAt });
    expect(one.email.subject).toBe("AIQSA user reached their monthly budget");
    expect(one.email.text).toContain("This person reached their monthly budget");
    expect(one.email.text).toContain("- Unnamed user: $1.00 of $1.00");
    expect(one.push.title).toBe("A user reached their monthly budget");
  });

  it("counts the users beyond the named ones", () => {
    const users = Array.from({ length: 53 }, (_, index) =>
      ({ budgetMicros: 1_000_000, displayName: `Person ${index}`, spentMicros: 1_000_000, userId: `user-${index}` }));
    const content = usersAlertContent(users, { appBaseUrl, resetsAt });
    expect(content.email.text.match(/^- Person /gmu)).toHaveLength(50);
    expect(content.email.text).toContain("- and 3 more");
    expect(content.push.body).toBe("Person 0, Person 1, Person 2 and 50 more · no new messages until November 1, 2026 (UTC)");
  });
});
