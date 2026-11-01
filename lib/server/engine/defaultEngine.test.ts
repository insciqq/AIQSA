import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIME_MS } from "../../contracts/research";
import { createResearchClock } from "../research/clock";
import { NOOP_RESEARCH_PORTS, researchPorts, type ResearchRunScope } from "../research/ports";
import type { StorageAdapter } from "../uploads/storage";
import { defaultNativeEngineDeps } from "./defaultEngine";

vi.mock("../prisma", () => ({ prisma: {} }));

/**
 * What a real run gets. A port reaches production only from `research` here (`lib/server/research/ports.ts`), and a unit test of
 * the port itself cannot see one that was never wired: the last queue lost a real dependency that way.
 */
describe("the engine a real run gets", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("has the research clock as its time port, not the no-op", () => {
    const deps = defaultNativeEngineDeps({} as StorageAdapter, {} as PrismaClient);
    expect(deps.research?.ports?.time).toBe(createResearchClock);
    const extendTurn = vi.fn();
    const run: ResearchRunScope = { branchRunIds: [], chatId: "chat", extendTurn, now: () => Date.now(), researchRunId: "run", runId: "run", sources: { opened: async () => [] },
      userFollowups: async () => [], userId: "user", userMessage: "" };
    const { time } = researchPorts(deps.research?.ports, run);
    expect(time).not.toBe(NOOP_RESEARCH_PORTS.time);
    time.planReleased();
    expect(extendTurn).toHaveBeenCalledExactlyOnceWith(Date.now() + RESEARCH_TIME_MS.hardEnd);
  });
});
