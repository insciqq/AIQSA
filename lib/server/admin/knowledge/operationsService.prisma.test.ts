import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createAdminKnowledgeOperationsService } from "./operationsService";

describe("administrator Knowledge operations projection", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads aggregate operational evidence without projecting private content", async () => {
    const result = await createAdminKnowledgeOperationsService(prisma).read();

    expect(result.checkedAt).toSatisfy((value: string) => Number.isFinite(Date.parse(value)));
    expect(result.ingestion.pendingArtifacts).toBeGreaterThanOrEqual(0);
    expect(result.retrieval.operations24h).toBeGreaterThanOrEqual(0);
    expect(result.migration.discrepancies).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:fileName|sourceName|baseName|query|excerpt|storageKey|providerText)"/u
    );
  });
});
