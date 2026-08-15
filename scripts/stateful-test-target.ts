import { pathToFileURL } from "node:url";

type StatefulTestEnvironment = Readonly<Record<string, string | undefined>>;

const CONTAINER_GUIDANCE =
  "run stateful checks through docker-compose.dev.yml (normally npm run check:container)";

function refuse(code: string): never {
  throw new Error(`${code}: ${CONTAINER_GUIDANCE}`);
}

export function isDisposableStatefulDatabaseUrl(
  value: string | undefined
): boolean {
  if (!value) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const parameters = [...parsed.searchParams.entries()];
  return (
    parsed.protocol === "postgresql:" &&
    parsed.username === "aiqsa" &&
    parsed.password.length > 0 &&
    parsed.hostname === "postgres" &&
    parsed.port === "5432" &&
    parsed.pathname === "/aiqsa" &&
    parsed.hash === "" &&
    parameters.length === 1 &&
    parameters[0]?.[0] === "schema" &&
    parameters[0]?.[1] === "public"
  );
}

export function assertDisposableStatefulTestTarget(
  environment: StatefulTestEnvironment
): void {
  if (environment.AIQSA_STATEFUL_TEST_TARGET !== "DISPOSABLE") {
    return refuse("stateful_test_target_not_acknowledged");
  }
  if (
    environment.AIQSA_TEST_MODE !== "1" ||
    environment.NODE_ENV === "production"
  ) {
    return refuse("stateful_test_mode_not_authorized");
  }
  if (!isDisposableStatefulDatabaseUrl(environment.DATABASE_URL)) {
    return refuse("stateful_test_database_not_disposable");
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  assertDisposableStatefulTestTarget(process.env);
}
