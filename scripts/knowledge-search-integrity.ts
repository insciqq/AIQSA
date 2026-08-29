import { PrismaClient } from "@prisma/client";
import { inspectKnowledgeSearchIntegrity } from "../lib/server/knowledge/searchProjection";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await inspectKnowledgeSearchIntegrity({ client: prisma });
  console.info(JSON.stringify({ event: "knowledge_search_integrity", ...result }));
  if (!result.healthy) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error
      ? error.message
      : "knowledge_search_integrity_failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
