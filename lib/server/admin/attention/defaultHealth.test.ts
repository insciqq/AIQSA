// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  discord: vi.fn(async () => ({
    connected: true, enabled: false, lastConnectedAt: null as Date | null, lastFailureAt: null as Date | null, lastFailureCode: null as string | null,
    setupReady: true
  })),
  failedRuns: vi.fn(async () => ({ runs: 2, users: 1, groups: [], groupsTruncated: false })),
  memoryRebuilds: vi.fn(async () => [])
}));
vi.mock("../../prisma", () => ({ prisma: {} }));
vi.mock("../../telemetry/store", () => ({ createPrismaTelemetryStore: () => ({}) }));
vi.mock("../health/failedRuns", () => ({ readFailedRunLoad: reads.failedRuns }));
vi.mock("../health/memoryRebuilds", () => ({ readMemoryRebuildLoad: reads.memoryRebuilds }));
vi.mock("../../discord/defaultDiscord", () => ({ readDiscordHealthSnapshot: reads.discord }));
vi.mock("./healthRules", async (importOriginal) => ({
  ...await importOriginal<typeof import("./healthRules")>(),
  memoryRebuildFindings: () => [],
  readHealthFindings: async () => []
}));

import { readDefaultHealthFindings } from "./defaultHealth";

describe("default health findings", () => {
  it("counts failed answers without the old core's runs the upgrade ended", async () => {
    const findings = await readDefaultHealthFindings();
    expect(reads.failedRuns).toHaveBeenCalledWith({}, expect.objectContaining({ withoutRetiredEngineEnds: true }));
    expect(findings).toEqual([{ code: "runs_failed", runs: 2, users: 1 }]);
  });

  it("names a Discord bot that cannot answer right after failed runs, and drops only that rule when it cannot be read", async () => {
    reads.discord.mockResolvedValueOnce({
      connected: false, enabled: true, lastConnectedAt: null, lastFailureAt: new Date(), lastFailureCode: "discord_token_rejected", setupReady: true
    });
    expect(await readDefaultHealthFindings()).toEqual([{ code: "runs_failed", runs: 2, users: 1 }, { code: "discord_token_rejected" }]);
    reads.discord.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await readDefaultHealthFindings()).toEqual([{ code: "runs_failed", runs: 2, users: 1 }]);
  });
});
