/**
 * Budget alerts end to end on the test-auth stand: the alert worker checks
 * every 3 s (`lib/server/usageLimits/defaultAlerts.ts`), and under test auth
 * the product email dispatcher captures every message before it reads the SMTP
 * configuration (`lib/server/email/defaultEmail.ts`), so no SMTP setup is
 * needed; `/api/test/auth-mails` lists what was captured.
 *
 * Synthetic people carry the scenario: an active administrator with a
 * verified email (a recipient), and a user whose seeded personal spend is
 * above the budget set for them. The pooled cap is set first to 90% of the
 * month's spend, then below it. Every recipient gets exactly one email per
 * threshold (cap almost used, cap reached, the user's budget reached), and
 * further checks send nothing more. The synthetic people (with their spend,
 * override and alert rows), the cap and the pooled-cap alert rows of the
 * month are removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeAdminUsageLimitsResponse, type AdminUsageLimits } from "../../lib/contracts/usageLimits";
import { authenticateWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const CHECK_INTERVAL_MS = 3_000;
const MAIL_TIMEOUT_MS = 45_000;
const SUBJECTS = {
  capNear: "AIQSA monthly cap almost used",
  capReached: "AIQSA monthly cap reached",
  userBudget: /^AIQSA users? reached their monthly budget$/u
} as const;

type CapturedEmail = Readonly<{ subject: string; text: string; to: string }>;

async function capturedEmails(request: APIRequestContext): Promise<CapturedEmail[]> {
  const response = await request.get("/api/test/auth-mails");
  expect(response.ok(), "the stand runs with test auth and captured email").toBe(true);
  return (await response.json() as { emails: CapturedEmail[] }).emails;
}

async function readLimits(request: APIRequestContext): Promise<AdminUsageLimits> {
  const limits = decodeAdminUsageLimitsResponse(await (await request.get("/api/admin/usage-limits")).json());
  expect(limits).not.toBeNull();
  return limits!.limits;
}

async function setCap(request: APIRequestContext, monthlyCapMicros: number | null): Promise<void> {
  const { installation } = await readLimits(request);
  const response = await request.patch("/api/admin/usage-limits/installation", { data: {
    expectedVersion: installation.version, messagesPerDay: installation.messagesPerDay, messagesPerHour: installation.messagesPerHour,
    monthlyBudgetMicros: installation.monthlyBudgetMicros, monthlyCapMicros
  } });
  expect(response.ok(), `the pooled cap is saved (${response.status()})`).toBe(true);
}

/** Active administrators an alert email reaches: the alert store's own rule (verified account email). */
async function emailRecipients(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    orderBy: { id: "asc" }, take: 100, where: { role: "admin", status: "active" },
    select: { authIdentities: { select: { normalizedEmail: true }, where: { emailVerifiedAt: { not: null } } }, email: true }
  });
  return admins.flatMap((admin) => {
    const email = admin.email?.trim() || null;
    return email && admin.authIdentities.some((identity) => identity.normalizedEmail === email.toLowerCase()) ? [email.toLowerCase()] : [];
  });
}

/** The link line of an alert: Control Center → Budgets & limits on the stand. */
function adminLink(text: string): URL | null {
  const line = text.split("\n").map((value) => value.trim()).filter(Boolean).at(-1);
  try {
    return line ? new URL(line) : null;
  } catch {
    return null;
  }
}

test("pooled cap and personal budget alerts reach every administrator once per threshold", async ({ request }, testInfo) => {
  test.setTimeout(240_000);
  await authenticateWithLocalToken(request);
  const tag = randomUUID().slice(0, 8);
  const admin = { displayName: `Alert admin ${tag}`, email: `alert-admin-${tag}@example.test`, id: randomUUID() };
  const person = { displayName: `Alert budget ${tag}`, email: `alert-budget-${tag}@example.test`, id: randomUUID() };
  const original = await readLimits(request);
  const periodStart = new Date(original.periodStart);
  const startedAt = new Date();
  const summary: Record<string, unknown> = {};
  try {
    // Earlier specs may have settled this month's pooled-cap alerts; without
    // their rows the thresholds below alert again.
    await prisma.usageLimitAlert.deleteMany({ where: { periodStart, userId: null } });
    await prisma.user.create({ data: {
      authIdentities: { create: { emailVerifiedAt: new Date(), normalizedEmail: admin.email, provider: "password", providerAccountId: admin.email } },
      displayName: admin.displayName, email: admin.email, id: admin.id, role: "admin", status: "active"
    } });
    await prisma.user.create({ data: { displayName: person.displayName, email: person.email, id: person.id, status: "active" } });
    const baseline = (await capturedEmails(request)).length;
    const since = async () => (await capturedEmails(request)).slice(baseline);

    // The person's personal spend is above their budget.
    await prisma.usageEvent.create({ data: {
      estimatedCostMicros: 50_000_000, inputTokens: 1_000, modelId: `usage-alerts-${tag}`, outputTokens: 100, provider: "openai",
      purpose: "chat_answer", totalTokens: 1_100, usageCompleteness: "COMPLETE", userId: person.id
    } });
    const budget = await request.put(`/api/admin/usage-limits/users/${person.id}`, { data: {
      exempt: false, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: 10_000_000
    } });
    expect(budget.ok(), `the person's budget is saved (${budget.status()})`).toBe(true);

    // The pooled cap at 90% used: the "almost used" threshold, below 100%.
    const spent = (await readLimits(request)).installationSpentMicros;
    expect(spent).toBeGreaterThanOrEqual(50_000_000);
    await setCap(request, Math.floor(spent * 10 / 9));

    const recipients = await emailRecipients();
    expect(recipients, "the synthetic administrator is a recipient").toContain(admin.email);
    summary.recipients = recipients.length;
    const count = (emails: readonly CapturedEmail[], to: string, matches: (email: CapturedEmail) => boolean) =>
      emails.filter((email) => email.to.trim().toLowerCase() === to && matches(email)).length;
    const capNear = (email: CapturedEmail) => email.subject === SUBJECTS.capNear;
    const capReached = (email: CapturedEmail) => email.subject === SUBJECTS.capReached;
    const userBudget = (email: CapturedEmail) => SUBJECTS.userBudget.test(email.subject) &&
      email.text.includes(`- ${person.displayName}: `);

    await expect.poll(async () => {
      const emails = await since();
      return { capNear: count(emails, admin.email, capNear), userBudget: count(emails, admin.email, userBudget) };
    }, { intervals: [1_000], timeout: MAIL_TIMEOUT_MS }).toEqual({ capNear: 1, userBudget: 1 });

    // Below the month's spend: the "reached" threshold.
    await setCap(request, Math.floor(spent / 2));
    await expect.poll(async () => count(await since(), admin.email, capReached), { intervals: [1_000], timeout: MAIL_TIMEOUT_MS })
      .toBe(1);

    // Several more checks change nothing.
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS * 4 + 1_000));
    const emails = await since();
    for (const to of recipients) {
      expect({ capNear: count(emails, to, capNear), capReached: count(emails, to, capReached), userBudget: count(emails, to, userBudget) },
        "one email per threshold for each administrator").toEqual({ capNear: 1, capReached: 1, userBudget: 1 });
    }
    const mine = emails.filter((email) => email.to.trim().toLowerCase() === admin.email &&
      (capNear(email) || capReached(email) || userBudget(email)));
    for (const email of mine) {
      const link = adminLink(email.text);
      expect(link && `${link.pathname}${link.search}`, `"${email.subject}" links to Budgets & limits`).toBe("/admin?section=limits");
    }
    const near = mine.find(capNear)!;
    expect(near.text).toMatch(/The monthly cap for everyone in AIQSA is (8\d|9\d)% used\./u);
    expect(mine.find(capReached)!.text).toContain("The monthly cap for everyone in AIQSA is reached.");
    expect(mine.find(userBudget)!.text).toContain(`- ${person.displayName}: $50.00 of $10.00`);

    const rows = await prisma.usageLimitAlert.findMany({ where: { OR: [{ userId: null }, { userId: person.id }], periodStart } });
    expect(rows.map(({ attempts, kind, state }) => ({ attempts, kind, state })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { attempts: 1, kind: "installation_cap_near", state: "delivered" },
      { attempts: 1, kind: "installation_cap_reached", state: "delivered" },
      { attempts: 1, kind: "user_budget_reached", state: "delivered" }
    ]);
    summary.emailsToSyntheticAdmin = mine.length;
    summary.alertRows = rows.length;
  } finally {
    await setCap(request, original.installation.monthlyCapMicros).catch(() => undefined);
    // Cascades remove the people's spend, budget override and alert rows.
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, person.id] } } });
    await prisma.usageLimitAlert.deleteMany({ where: { claimedAt: { gte: startedAt }, periodStart, userId: null } });
  }
  await testInfo.attach("usage-alerts-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
});
