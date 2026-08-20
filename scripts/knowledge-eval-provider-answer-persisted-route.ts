import { prisma } from "../lib/server/prisma";
import { createS3StorageAdapter } from "../lib/server/uploads/storage";
import {
  captureProviderAnswerPersistedRoute,
  parseProviderAnswerPersistedRouteCli,
  readProviderAnswerArtifactDirectory,
  writeProviderAnswerPersistedRouteCapture,
  ProviderAnswerPersistedRouteError
} from "../tests/knowledge-evals/providerAnswerPersistedRoute";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

const usage = [
  "Usage: npm run eval:knowledge:provider-answers:persisted-route --",
  "  --provider <anthropic|gemini|openai>",
  "  --input-review-dir </tmp/aiqsa-knowledge-provider-review-...>",
  "  --output-review-dir </tmp/aiqsa-knowledge-provider-review-...>",
  "  --promotion-dir </tmp/aiqsa-knowledge-provider-persisted-route-...>"
].join(" ");

async function main(): Promise<void> {
  const options = parseProviderAnswerPersistedRouteCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  try {
    assertDisposableStatefulTestTarget(process.env);
  } catch {
    throw new ProviderAnswerPersistedRouteError(
      "knowledge_provider_answer_persisted_route_database_unsafe"
    );
  }
  const artifacts = await readProviderAnswerArtifactDirectory(
    options.inputReviewDirectory!
  );
  const capture = await captureProviderAnswerPersistedRoute({
    artifacts,
    client: prisma,
    provider: options.provider!,
    storage: createS3StorageAdapter()
  });
  await writeProviderAnswerPersistedRouteCapture({
    capture,
    outputReviewDirectory: options.outputReviewDirectory!,
    promotionDirectory: options.promotionDirectory!
  });
  process.stdout.write(`${JSON.stringify(capture.report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null &&
    "code" in error && typeof (error as ProviderAnswerPersistedRouteError).code === "string"
    ? (error as ProviderAnswerPersistedRouteError).code
    : "knowledge_provider_answer_persisted_route_failed";
  process.stderr.write(`Knowledge provider-answer persisted-route capture failed: ${code}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
