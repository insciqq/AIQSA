import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { MCP_GUARD_UNAVAILABLE_REASON } from "../../lib/server/mcp/guard";
import { FAKE_MCP_GUARD_REASON } from "../support/fakeMcpGuardProvider";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { assignMcpGuard, installFakeMcpGuard, mcpGuardCard, newMcpGuardChat, screenshotMcpGuardCard,
  sendMcpGuardTurn, withMcpGuardStand, type InstalledFakeMcpGuard } from "./support/mcpGuard";
import { lastAnswer } from "./support/workspace";

// Disposable, serial stand: this spec temporarily owns the installation guard role. No real provider is contacted.
test.describe.configure({ mode: "serial", timeout: 600_000 });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("interactive writes retain human approval semantics and show automatic verdicts across layouts", async ({ browser }, testInfo) => {
  let guard: InstalledFakeMcpGuard | undefined;
  try {
    await withMcpGuardStand(browser, prisma, async stand => {
      const { page, endpoint } = stand;
      guard = await installFakeMcpGuard(prisma);
      const send = async (id: string, decision: "ask" | "allow") => {
        await newMcpGuardChat(page);
        return sendMcpGuardTurn(stand, `Create an issue titled ${id}. [AIQSA_MCP_E2E:create_issue:${id}]`, decision);
      };
      await test.step("unset role keeps the ordinary card and sends nothing", async () => {
        await send("role-unset", "ask");
        const card = mcpGuardCard(stand);
        await expect(card).toContainText("This tool may change data, so nothing was sent.");
        await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
        expect(endpoint.dispatches("create_issue")).toBe(0);
        expect(guard!.calls()).toBe(0);
      });

      await assignMcpGuard(page.request, guard.modelId);
      await test.step("allow dispatches once and marks the card automatically allowed", async () => {
        guard!.setVerdict("allow");
        const chatId = await send("automatic-allow", "allow");
        const card = mcpGuardCard(stand);
        await expect(card).toContainText("Allowed automatically");
        for (const name of ["Allow once", "Deny", "Always allow for this server"]) {
          await expect(card.getByRole("button", { name, exact: true })).toHaveCount(0);
        }
        expect(endpoint.dispatches("create_issue", { title: "automatic-allow" })).toBe(1);
        expect(guard!.calls()).toBe(1);
        expect(await prisma.mcpToolApproval.findMany({ where: { chatId }, select: { decision: true, guardDecision: true } }))
          .toEqual([{ decision: null, guardDecision: "allow" }]);
        await screenshotMcpGuardCard(page, card, testInfo, "allowed");
      });

      await test.step("ask shows its reason; Allow once continues exactly once without another guard call", async () => {
        guard!.setVerdict("ask");
        const chatId = await send("human-once", "ask");
        const card = mcpGuardCard(stand);
        await expect(card).toContainText(FAKE_MCP_GUARD_REASON);
        expect(endpoint.dispatches("create_issue", { title: "human-once" })).toBe(0);
        await screenshotMcpGuardCard(page, card, testInfo, "refused");
        const before = guard!.calls();
        await card.getByRole("button", { name: "Allow once", exact: true }).click();
        await expect(lastAnswer(page)).toContainText("MCP call finished: done.", { timeout: 120_000 });
        await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
        expect(endpoint.dispatches("create_issue", { title: "human-once" })).toBe(1);
        expect(guard!.calls()).toBe(before);
        const approval = await prisma.mcpToolApproval.findFirstOrThrow({ where: { chatId, decision: "allow_once" } });
        expect(approval.consumedAt).not.toBeNull();
      });

      await test.step("Always allow remains subject to the guard in a later chat", async () => {
        await send("consent-first", "ask");
        await mcpGuardCard(stand).getByRole("button", { name: "Always allow for this server", exact: true }).click();
        await expect(lastAnswer(page)).toContainText("MCP call finished: done.", { timeout: 120_000 });
        await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
        expect(endpoint.dispatches("create_issue", { title: "consent-first" })).toBe(1);
        expect(await prisma.mcpToolConsent.count({ where: { serverId: stand.serverId, userId: stand.userId } })).toBe(1);
        const before = guard!.calls();
        await send("consent-still-guarded", "ask");
        await expect(mcpGuardCard(stand)).toContainText(FAKE_MCP_GUARD_REASON);
        await expect(mcpGuardCard(stand).getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
        expect(guard!.calls()).toBe(before + 1);
        expect(endpoint.dispatches("create_issue", { title: "consent-still-guarded" })).toBe(0);
      });

      for (const verdict of ["failure", "malformed"] as const) {
        await test.step(`${verdict} asks with the stable reason, even with standing consent`, async () => {
          guard!.setVerdict(verdict);
          const before = guard!.calls();
          await send(`guard-${verdict}`, "ask");
          await expect(mcpGuardCard(stand)).toContainText(MCP_GUARD_UNAVAILABLE_REASON);
          await expect(mcpGuardCard(stand).getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
          expect(guard!.calls()).toBe(before + 1);
          expect(endpoint.dispatches("create_issue", { title: `guard-${verdict}` })).toBe(0);
        });
      }

      await test.step("Defaults & roles exposes the assigned MCP guard at desktop and phone sizes", async () => {
        await page.goto("/admin?section=roles");
        const row = page.getByTestId("admin-role-mcp-guard");
        await expect(row).toContainText("MCP guard");
        await expect(row).toContainText("Model ready");
        await expect(row.getByRole("button", { name: "MCP guard deployment", exact: true })).toContainText("Synthetic MCP guard");
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.colorScheme = value; }, theme);
          for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            await row.scrollIntoViewIfNeeded();
            await expect(row).toBeVisible();
            await expectNoHorizontalOverflow(page);
            await page.screenshot({ path: testInfo.outputPath(`mcp-guard-role-${theme}-${viewport.name}.png`) });
          }
        }
      });
    });
  } finally { await guard?.dispose(); }
});
