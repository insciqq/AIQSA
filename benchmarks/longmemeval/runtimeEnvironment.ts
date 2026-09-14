import { loadEnvConfig } from "@next/env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBenchmarkDatabaseUrl } from "./contract";

// Evaluate before server singletons. Never let a benchmark utility connect to
// an installation DATABASE_URL inherited from .env.
if (process.env.AIQSA_MEMORY_BENCHMARK_ACK !== "DISPOSABLE_PAID_LONGMEMEVAL") {
  throw new Error("longmemeval_disposable_authority_required");
}
const port = Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT ?? "55437");
const database = assertBenchmarkDatabaseUrl(process.env.AIQSA_MEMORY_BENCHMARK_DATABASE_URL ?? "", port);
database.searchParams.set("connection_limit", "4");
export const runtimeDatabaseUrl = database.toString();
process.env.DATABASE_URL = runtimeDatabaseUrl;
loadEnvConfig(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), true, { info() {}, error() {} });
if (process.env.DATABASE_URL !== runtimeDatabaseUrl) throw new Error("longmemeval_database_authority_changed");
