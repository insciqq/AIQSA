import type { Prisma } from "@prisma/client";
import { listMemoryModelRecommendations } from "../memory/modelRecommendations";

const RECOMMENDATION_ADOPTION_VERSION = 2;

/** Called only by installation bootstrap/seed in a transaction, never by a
 * catalog read. The marker survives model removal and explicit clears. */
export async function adoptMemoryModelRecommendation(tx: Prisma.TransactionClient): Promise<void> {
  const policy = await tx.memoryUtilityModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  if (policy.recommendationAdoptionVersion >= RECOMMENDATION_ADOPTION_VERSION) return;
  if (policy.assignmentSource === "OPERATOR") {
    await tx.memoryUtilityModelPolicy.updateMany({
      where: { id: policy.id, version: policy.version, recommendationAdoptionVersion: policy.recommendationAdoptionVersion,
        assignmentSource: "OPERATOR" },
      data: { recommendationAdoptionVersion: RECOMMENDATION_ADOPTION_VERSION, recommendationAdoptionReason: "preserved_operator" }
    });
    return;
  }
  const models = await tx.providerModel.findMany({
    where: { enabled: true, connection: { enabled: true } },
    select: { id: true, displayName: true, connectionId: true, activeConfig: true }
  });
  const recommendation = (await listMemoryModelRecommendations(tx, models))
    .find((entry) => entry.unavailableReason === null);
  await tx.memoryUtilityModelPolicy.updateMany({
    where: { id: policy.id, version: policy.version, recommendationAdoptionVersion: policy.recommendationAdoptionVersion,
      assignmentSource: { not: "OPERATOR" } },
    data: { recommendationAdoptionVersion: RECOMMENDATION_ADOPTION_VERSION,
      recommendationAdoptionReason: recommendation ? "applied" : "no_eligible_model",
      ...(recommendation ? { providerModelId: recommendation.providerModelId,
        reasoningEffort: recommendation.reasoningEffort, assignmentSource: "BOOTSTRAP",
        updatedByUserId: null, version: { increment: 1 } } : {}) }
  });
}
