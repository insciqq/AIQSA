import { PrismaClient } from "@prisma/client";
import { providerTemplateIds } from "../lib/domain/providerTemplates";
import { synchronizeCodeOwnedCatalog } from "../lib/server/bootstrap/codeOwnedCatalog";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  assertDisposableStatefulTestTarget(process.env);
  const result = await synchronizeCodeOwnedCatalog(prisma, {
    mode: "local_seed"
  });
  if (result.providerModelIds.get("fake:fake-qsa") !== providerTemplateIds.fakeModel) {
    throw new Error("stateful_test_catalog_fake_model_identity_invalid");
  }
  console.info(
    `AIQSA stateful test catalog seeded: models=${result.modelCount}, search options=${result.searchOptionCount}`
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error &&
      /^stateful_test_(?:target|mode|database|catalog)_[a-z_]+(?::|$)/u.test(error.message)
      ? error.message
      : "stateful_test_catalog_seed_failed";
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
