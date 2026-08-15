import { pathToFileURL } from "node:url";

type StatefulTestEnvironment = Readonly<Record<string, string | undefined>>;

const DISPOSABLE_DATABASE_URL =
  "postgresql://aiqsa:aiqsa-dev-password@postgres:5432/aiqsa?schema=public";

export function assertDisposableStatefulTestTarget(
  environment: StatefulTestEnvironment
): void {
  if (environment.AIQSA_STATEFUL_TEST_TARGET !== "DISPOSABLE") {
    throw new Error("stateful_test_target_not_acknowledged");
  }
  if (
    environment.AIQSA_TEST_MODE !== "1" ||
    environment.NODE_ENV === "production"
  ) {
    throw new Error("stateful_test_mode_not_authorized");
  }
  if (environment.DATABASE_URL !== DISPOSABLE_DATABASE_URL) {
    throw new Error("stateful_test_database_not_disposable");
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  assertDisposableStatefulTestTarget(process.env);
}
