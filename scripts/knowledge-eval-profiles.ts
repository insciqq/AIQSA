import { stderr, stdout } from "node:process";
import {
  knowledgeProfileBenchmarkCliErrorCode,
  KNOWLEDGE_PROFILE_BENCHMARK_CLI_USAGE,
  runKnowledgeProfileBenchmarkCli
} from "../tests/knowledge-evals/profileBenchmarkCli";

runKnowledgeProfileBenchmarkCli(process.argv.slice(2))
  .then((report) => stdout.write(report
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${KNOWLEDGE_PROFILE_BENCHMARK_CLI_USAGE}\n`))
  .catch((error: unknown) => {
    stderr.write(`knowledge profile benchmark failed: ${knowledgeProfileBenchmarkCliErrorCode(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prismaDisconnect());

async function prismaDisconnect(): Promise<void> {
  try {
    const { prisma } = await import("../lib/server/prisma");
    await prisma.$disconnect();
  } catch {
    stderr.write("knowledge profile benchmark failed: knowledge_profile_benchmark_disconnect_failed\n");
    process.exitCode = 1;
  }
}
