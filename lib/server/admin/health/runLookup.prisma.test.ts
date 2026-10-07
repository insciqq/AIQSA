// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { createAdminHealthRunLookup } from "./runLookup";
import { adminHealthRunLookupStatement, createPrismaAdminHealthRunRepository } from "./runLookupRepository";

// Every row belongs to this file's own user, chat and run ids; only they are removed.
const OWNER = `run-lookup-owner-${randomUUID()}`;
const FIRST = randomUUID();
const PREFIX = FIRST.slice(0, 8);
const SIBLING = `${PREFIX}-0000-4000-8000-${randomBytes(6).toString("hex")}`;
const STRANGER = `${PREFIX.slice(0, 7)}${PREFIX[7] === "0" ? "1" : "0"}${FIRST.slice(8)}`;
const OWN_RUNS = [FIRST, SIBLING, STRANGER];
const store = createPrismaTelemetryStore(prisma);
const lookup = createAdminHealthRunLookup({ runs: createPrismaAdminHealthRunRepository(prisma), incidents: store });

function incident(runId: string, minutesAgo: number) {
  return {
    occurredAt: new Date(Date.now() - minutesAgo * 60_000), role: "app", event: "run_execution", level: "error" as const,
    appVersion: "run-lookup-test", instanceId: "c".repeat(32), code: "provider_auth_rejected", subsystem: null,
    connectionId: null, runId, traceId: null, details: {}
  };
}

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "TelemetryIncident" WHERE "runId" = ANY(${OWN_RUNS}::text[])`;
  await prisma.user.deleteMany({ where: { id: OWNER } });
  await prisma.$disconnect();
});

describe("admin health run lookup on PostgreSQL", () => {
  it("finds runs by error reference through the primary key without exposing content", async () => {
    await prisma.user.create({ data: { displayName: "Run lookup owner", id: OWNER, status: "active" } });
    const chat = await prisma.chat.create({ data: { title: "Private lookup title", userId: OWNER } });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: textMessageContent("Private lookup prompt"), role: "user", status: "complete" }
    });
    const created = new Date(Date.now() - 60_000);
    for (const [id, status] of [[FIRST, "error"], [SIBLING, "streaming"], [STRANGER, "complete"]] as const) {
      await prisma.modelRun.create({
        data: {
          id, chatId: chat.id, userId: OWNER, userMessageId: message.id, provider: "lookup-provider", modelId: "lookup-model",
          status, createdAt: created,
          ...(status === "error" ? { errorPayload: { code: "provider_auth_rejected", message: "Private provider detail" } } : {})
        }
      });
    }
    await store.write({ counters: [], incidents: [incident(FIRST, 2), incident(FIRST, 1), incident(STRANGER, 1)], lostObservations: 0 });

    const byReference = await lookup.lookup(PREFIX.toUpperCase());
    const own = byReference.runs.filter((run) => OWN_RUNS.includes(run.runId));
    expect(own.map((run) => run.runId)).toEqual([FIRST, SIBLING].sort());
    const failed = own.find((run) => run.runId === FIRST)!;
    expect(failed).toMatchObject({
      status: "error", failureCode: "provider_auth_rejected", connectionName: null, modelName: null, incidentCount: 2,
      startedAt: created.toISOString()
    });
    expect(failed.durationMs).toEqual(expect.any(Number));
    expect(own.find((run) => run.runId === SIBLING)).toMatchObject({ status: "streaming", durationMs: null, failureCode: null, incidentCount: 0 });
    expect(JSON.stringify(byReference)).not.toMatch(/Private|lookup-owner|lookup-model/u);

    await expect(lookup.lookup(FIRST)).resolves.toMatchObject({ runs: [{ runId: FIRST }], truncated: false });
    const incidents = await store.readIncidents({ runIdPrefix: PREFIX });
    expect(incidents.items.filter((item) => OWN_RUNS.includes(item.runId ?? "")).map((item) => item.runId)).toEqual([FIRST, FIRST]);

    // The prefix is answered from the primary-key btree, not a table scan.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${adminHealthRunLookupStatement(PREFIX, 6)}`);
    });
    expect(JSON.stringify(plan)).toMatch(/"Index Name":\s*"ModelRun_pkey"/u);
  });
});
