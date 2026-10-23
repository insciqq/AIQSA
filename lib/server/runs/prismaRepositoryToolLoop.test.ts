import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { appendRunOutputEvents, createPrismaRunToolLoopOperations } from "./prismaRepositoryToolLoop";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import { workspaceActivitySnapshot, WORKSPACE_ACTIVITY_RECEIPT, WORKSPACE_ACTIVITY_SNAPSHOT } from "./workspaceActivityPersistence";
import { summarizeMessageRunWorkspaceActivity } from "../chats/prismaRepository";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

function activityStore() {
  const rows: { eventType: string; payload: unknown; sequence: number }[] = [];
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const modelRunEvent = {
    aggregate: async () => ({ _max: { sequence: Math.max(-1, ...rows.map((row) => row.sequence)) } }),
    createMany: vi.fn(async ({ data }: { data: typeof rows }) => { rows.push(...data); }),
    findFirst: async ({ where }: { where: { eventType: string; payload?: { path: string[]; equals: string } } }) =>
      [...rows].reverse().find((row) => row.eventType === where.eventType && (!where.payload ||
        where.payload.path.reduce<unknown>((value, key) => object(value)[key], row.payload) === where.payload.equals)) ?? null,
    findMany: async () => rows.filter((row) => row.eventType === "artifact" && object(row.payload).artifactType === "workspace_activity"),
    findUnique: async () => rows.find((row) => row.sequence === -1) ?? null,
    upsert: async ({ create, update }: { create: typeof rows[number]; update: { payload: unknown } }) => {
      const existing = rows.find((row) => row.sequence === -1);
      if (existing) existing.payload = update.payload;
      else rows.push(create);
    }
  };
  return { rows, tx: { modelRunEvent } as unknown as Prisma.TransactionClient };
}

describe("Workspace activity publication", () => {
  it("deduplicates grounded output and Workspace replays within one ordered output stream", async () => {
    const { rows, tx } = activityStore();
    const display: RunOutputArtifactEvent = { type: "grounding_display", data: {
      provider: "gemini", suggestionsHtml: '<a href="https://www.google.com/search?q=weather">Weather</a>',
      citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source" }]
    } };
    const activity: RunOutputArtifactEvent = { type: "artifact", data: {
      artifactType: "workspace_activity",
      payload: { id: "command", updateId: "started", kind: "command", phase: "running", command: { preview: "command" } }
    } };
    const first = await appendRunOutputEvents(tx, "run", [display, activity, display]);
    const replay = await appendRunOutputEvents(tx, "run", [activity, display]);
    expect(rows.map(({ eventType, sequence }) => ({ eventType, sequence }))).toEqual([
      { eventType: "grounding_display", sequence: 0 }, { eventType: WORKSPACE_ACTIVITY_RECEIPT, sequence: 1 },
      { eventType: WORKSPACE_ACTIVITY_SNAPSHOT, sequence: -1 }
    ]);
    expect(first).toMatchObject([display, { data: { payload: { sequence: 1 } } }, display]);
    expect(replay).toEqual([first[1], display]);
  });

  it.each(["complete", "error", "cancelled"] as const)("keeps provider output fenced after %s while allowing Workspace settlement", async (status) => {
    const store = activityStore();
    const createMany = store.tx.modelRunEvent.createMany;
    const tx = {
      $queryRaw: async () => [{ id: "run", status, errorPayload: { recoveryTerminal: true } }],
      modelRun: { update: vi.fn() },
      modelRunEvent: { ...store.tx.modelRunEvent, aggregate: async () => ({ _max: { sequence: 3 } }) }
    };
    const operations = createPrismaRunToolLoopOperations({
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
    } as unknown as PrismaClient);
    await operations.appendRunOutputEvent("run", {
      type: "artifact", data: { artifactType: "reasoning", payload: { entry: "start", text: "Late provider output" } }
    });
    expect(createMany).not.toHaveBeenCalled();
    const published = await operations.appendRunOutputEvent("run", {
      type: "artifact", data: { artifactType: "workspace_activity", payload: {
        id: "stopped", kind: "workspace_stopped", phase: "succeeded"
      } }
    });
    expect(published).toMatchObject({ data: { payload: { sequence: 4 } } });
    expect(createMany).toHaveBeenCalledOnce();
  });

  it("reuses the first durable sequence and payload when a settled tool artifact is replayed", async () => {
    const { rows, tx } = activityStore();
    const event = (updateId: string, phase: "running" | "succeeded"): RunOutputArtifactEvent => ({
      data: { artifactType: "workspace_activity", payload: { command: { preview: "command" }, id: "command", kind: "command", phase, updateId } },
      type: "artifact"
    });
    const first = await appendRunOutputEvents(tx, "run", [event("start", "running")]);
    const last = await appendRunOutputEvents(tx, "run", [event("poll", "succeeded"), event("poll", "succeeded")]);
    const replay = await appendRunOutputEvents(tx, "run", [event("start", "running")]);
    expect(first).toMatchObject([{ data: { payload: { sequence: 0 } } }]);
    expect(last).toMatchObject([{ data: { payload: { sequence: 1 } } }, { data: { payload: { sequence: 1 } } }]);
    expect(replay).toEqual(first);
    expect(rows.filter((row) => row.eventType === WORKSPACE_ACTIVITY_RECEIPT)).toHaveLength(2);
    expect(workspaceActivitySnapshot(rows.find((row) => row.sequence === -1)?.payload)?.entries).toHaveLength(1);
  });

  it("retains one bounded snapshot, value-free replay receipts and the same live/reload feed", async () => {
    const { rows, tx } = activityStore();
    const events: RunOutputArtifactEvent[] = Array.from({ length: 600 }, (_, index) => ({
      type: "artifact", data: { artifactType: "workspace_activity", payload: {
        id: `step:${index}`, updateId: `update:${index}`, kind: "command", phase: index === 0 ? "running" : index === 2 ? "failed" : "succeeded",
        command: { preview: `command ${index}`, stdoutPreview: `output ${index}` }
      } }
    }));
    const published = await appendRunOutputEvents(tx, "run", events);
    const stored = workspaceActivitySnapshot(rows.find((row) => row.sequence === -1)?.payload)!;
    const live = mergeWorkspaceActivity(null, { entries: published.flatMap((event) =>
      event.type === "artifact" && event.data.artifactType === "workspace_activity" ? [event.data.payload] : []) });
    expect(stored).toEqual(live);
    expect(stored.entries).toHaveLength(512);
    expect(stored.entries[0]).toMatchObject({ kind: "elided", count: 89, failedCount: 1, throughSequence: 89 });
    expect(stored.entries[1]?.id).toBe("step:0");
    const receipts = rows.filter((row) => row.eventType === WORKSPACE_ACTIVITY_RECEIPT);
    expect(receipts).toHaveLength(600);
    expect(JSON.stringify(receipts)).not.toMatch(/command|output /u);
    const replays = await appendRunOutputEvents(tx, "run", [events[3]!, events[599]!]);
    expect(replays).toEqual([published[3], published[599]]);
    expect(workspaceActivitySnapshot(rows.find((row) => row.sequence === -1)?.payload)).toEqual(stored);
    expect(summarizeMessageRunWorkspaceActivity({ events: rows, status: "streaming" })).toEqual(stored);
    const stopped = summarizeMessageRunWorkspaceActivity({ events: rows, status: "cancelled" })!;
    expect(stopped.entries[0]?.phase).toBe("requested");
    expect(stopped.entries[1]).toMatchObject({ phase: "unknown" });
  });

  it("rejects replacement text using a previously committed update identity", async () => {
    const { tx } = activityStore();
    const event: RunOutputArtifactEvent = { type: "artifact", data: { artifactType: "workspace_activity", payload: {
      id: "command", updateId: "update", kind: "command", phase: "succeeded", command: { preview: "original" }
    } } };
    await appendRunOutputEvents(tx, "run", [event]);
    await expect(appendRunOutputEvents(tx, "run", [{ ...event, data: { artifactType: "workspace_activity", payload: {
      id: "command", updateId: "update", kind: "command", phase: "succeeded", command: { preview: "replacement" }
    } } }])).rejects.toThrow("workspace_activity_replay_invalid");
  });

});

describe("resource change card publication", () => {
  /** Stored events, matched as PostgreSQL compares JSON values: by content, whatever the key order. */
  function cardStore() {
    const rows: { eventType: string; payload: unknown; sequence: number }[] = [];
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
    const modelRunEvent = {
      aggregate: async () => ({ _max: { sequence: Math.max(-1, ...rows.map((row) => row.sequence)) } }),
      createMany: vi.fn(async ({ data }: { data: typeof rows }) => { rows.push(...data); }),
      findFirst: async ({ where }: { where: { eventType: string; modelRunId: string; payload: { equals: unknown } } }) =>
        rows.find((row) => row.eventType === where.eventType && canonical(row.payload) === canonical(where.payload.equals)) ?? null
    };
    return { rows, tx: { modelRunEvent } as unknown as Prisma.TransactionClient };
  }
  const secret = (action: "created" | "delete_proposed" | "updated", versionId: string, proposalId: string | null = null): RunOutputArtifactEvent => ({
    type: "artifact", data: { artifactType: "resource_change", payload: { action, envNames: [], kind: "text", name: "GitLab",
      previousName: null, proposalId, resource: "secret", secretId: "10000000-0000-4000-8000-000000000001", valueReplaced: action === "updated",
      version: 1, versionId } }
  });

  it("keeps a change's card once when its settlement and then the engine publish it", async () => {
    const { rows, tx } = cardStore();
    const created = secret("created", "20000000-0000-4000-8000-000000000001");
    await appendRunOutputEvents(tx, "run", [created], { settlement: true });
    expect(await appendRunOutputEvents(tx, "run", [created])).toEqual([created]);
    expect(rows).toHaveLength(1);
    // The next change of the same secret names its own version, so it is its own card.
    await appendRunOutputEvents(tx, "run", [secret("updated", "20000000-0000-4000-8000-000000000002")]);
    expect(rows).toHaveLength(2);
  });

  it("keeps each proposal of an answer, and one card once within a batch", async () => {
    const { rows, tx } = cardStore();
    const version = "20000000-0000-4000-8000-000000000001";
    const first = secret("delete_proposed", version, "proposal-1");
    await appendRunOutputEvents(tx, "run", [first, secret("delete_proposed", version, "proposal-2"), first]);
    expect(rows.map((row) => (row.payload as { payload: { proposalId: string } }).payload.proposalId)).toEqual(["proposal-1", "proposal-2"]);
  });
});
