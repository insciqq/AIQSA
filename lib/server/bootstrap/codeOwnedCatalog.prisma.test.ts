import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerModelTemplateId, providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { synchronizeCodeOwnedCatalog } from "./codeOwnedCatalog";

const BUILT_IN_SEARCH_API_ID = "00000000-0000-4000-8000-000000001407";

class Rollback extends Error {}

afterAll(() => prisma.$disconnect());

describe("code-owned Search catalog on PostgreSQL", () => {
  it("makes a DeepSeek Search API source added by hand the built-in once, keeping its identity, state and route", async () => {
    const sourceConnectionId = providerTemplateIds.deepSeekConnection;
    const id = randomUUID();
    const optionId = `deepseek-search-api-${id.slice(0, 8)}`;
    // Everything runs in one transaction that is rolled back, so the shared
    // seeded catalog is left exactly as it was.
    const outcome = prisma.$transaction(async (tx) => {
      // v0.3.19: no built-in row; an administrator added the source by hand.
      await tx.searchOption.deleteMany({ where: { id: BUILT_IN_SEARCH_API_ID, strategies: { none: {} } } });
      expect(await tx.searchOption.count({ where: { kind: "deepseek_search_api", sourceConnectionId } })).toBe(0);
      await tx.searchOption.create({ data: { description: "Results from the API.", displayName: "My DeepSeek API",
        enabled: false, id, kind: "deepseek_search_api", optionId, sourceConnectionId } });
      await tx.searchStrategy.create({ data: { adapterKind: "provider_model_client", config: {}, credentialMode: "provider_model",
        description: "Results from the API.", displayName: "My DeepSeek API", draft: { protocol: "deepseek_search_api" },
        id: randomUUID(), kind: "provider_model_web_search", modelId: "deepseek-flash", provider: "deepseek",
        providerModelId: providerModelTemplateId("deepseek:deepseek-flash")!, searchOptionId: id, strategyId: `${optionId}:client` } });

      // An upgrade, then an ordinary restart.
      for (let start = 0; start < 2; start += 1) {
        await synchronizeCodeOwnedCatalog(tx, { mode: "installation", now: new Date() });
      }

      const sources = await tx.searchOption.findMany({ include: { strategies: true },
        where: { kind: "deepseek_search_api", sourceConnectionId } });
      expect(sources).toEqual([expect.objectContaining({ archivedAt: null, displayName: "DeepSeek Search API", enabled: false, id,
        optionId, templateKey: "search:deepseek-search-api" })]);
      expect(sources[0]!.strategies.map((strategy) => strategy.strategyId)).toEqual([`${optionId}:client`]);
      expect(await tx.searchOption.count({ where: { id: BUILT_IN_SEARCH_API_ID } })).toBe(0);
      throw new Rollback();
    }, { timeout: 60_000 });

    await expect(outcome).rejects.toBeInstanceOf(Rollback);
    expect(await prisma.searchOption.count({ where: { id } })).toBe(0);
    expect(await prisma.searchOption.count({ where: { id: BUILT_IN_SEARCH_API_ID, templateKey: "search:deepseek-search-api" } }))
      .toBe(1);
  });

  it("leaves the archived Perplexity Sonar source as the upgrade left it and creates no new one", async () => {
    const sonarId = "00000000-0000-4000-8000-000000001404";
    const outcome = prisma.$transaction(async (tx) => {
      // As the 2026-11-26 migration leaves an installation that had the built-in Sonar source.
      await tx.searchOption.upsert({
        create: { archivedAt: new Date("2026-11-26T12:00:00Z"), description: "Web search provided by Perplexity through OpenRouter.",
          displayName: "Perplexity Search", enabled: false, id: sonarId, kind: "perplexity_search", optionId: "perplexity-tool-search",
          sourceConnectionId: providerTemplateIds.openRouterConnection, templateKey: "search:perplexity" },
        update: { archivedAt: new Date("2026-11-26T12:00:00Z"), enabled: false },
        where: { id: sonarId }
      });
      const before = await tx.searchOption.findUniqueOrThrow({ include: { strategies: true }, where: { id: sonarId } });
      for (let start = 0; start < 2; start += 1) {
        await synchronizeCodeOwnedCatalog(tx, { mode: "installation", now: new Date() });
      }
      expect(await tx.searchOption.findUniqueOrThrow({ include: { strategies: true }, where: { id: sonarId } })).toEqual(before);
      expect(await tx.searchOption.count({ where: { archivedAt: null, kind: "perplexity_search" } })).toBe(0);
      expect(await tx.searchStrategy.count({ where: { archivedAt: null, enabled: true, kind: "perplexity_tool_search" } })).toBe(0);
      throw new Rollback();
    }, { timeout: 60_000 });
    await expect(outcome).rejects.toBeInstanceOf(Rollback);
  });
});
