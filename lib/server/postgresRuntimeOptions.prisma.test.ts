import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { assertDisposableStatefulTestTarget } from "../../scripts/stateful-test-target";
import { aiqsaPostgresRuntimeUrl } from "./postgresRuntimeOptions";

type ConnectionSettings = {
  applicationName: string;
  jit: string;
  pid: number;
  statisticsTarget: string;
};

describe("AIQSA PostgreSQL startup settings", () => {
  it.each([
    { name: "new options", options: undefined },
    { name: "existing operator options", options: "-c default_statistics_target=101 -c jit=on" }
  ])("disables JIT on every pooled connection with $name", async ({ options }) => {
    assertDisposableStatefulTestTarget(process.env);
    const url = new URL(process.env.DATABASE_URL ?? "");
    const poolSize = 3;
    const applicationName = "aiqsa-runtime-options-test";
    url.searchParams.set("connection_limit", String(poolSize));
    url.searchParams.set("application_name", applicationName);
    if (options) url.searchParams.set("options", options);
    const client = new PrismaClient({ datasourceUrl: aiqsaPostgresRuntimeUrl(url.toString()), log: [] });

    let arrived = 0;
    let release: () => void = () => undefined;
    const allConnected = new Promise<void>((resolve) => { release = resolve; });
    const releaseTimeout = setTimeout(release, 5_000);
    const probes = Array.from({ length: poolSize }, () => client.$transaction(async (tx) => {
      const [settings] = await tx.$queryRaw<ConnectionSettings[]>(Prisma.sql`
        SELECT current_setting('jit') AS jit,
          current_setting('application_name') AS "applicationName",
          current_setting('default_statistics_target') AS "statisticsTarget",
          pg_backend_pid() AS pid
      `);
      // Hold each connection until every probe has acquired a different one.
      arrived += 1;
      if (arrived === poolSize) release();
      await allConnected;
      return settings;
    }, { maxWait: 5_000, timeout: 10_000 }));

    try {
      const settings = await Promise.all(probes);
      expect(new Set(settings.map((row) => row?.pid)).size).toBe(poolSize);
      for (const row of settings) {
        expect(row?.jit).toBe("off");
        expect(row?.applicationName).toBe(applicationName);
        if (options) expect(row?.statisticsTarget).toBe("101");
      }
    } finally {
      clearTimeout(releaseTimeout);
      release();
      await Promise.allSettled(probes);
      await client.$disconnect();
    }
  }, 20_000);
});
