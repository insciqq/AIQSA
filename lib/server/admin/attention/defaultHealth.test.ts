// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  failedRuns: vi.fn(async () => ({ runs: 2, users: 1, groups: [], groupsTruncated: false })),
  memoryRebuilds: vi.fn(async () => [])
}));
vi.mock("../../prisma", () => ({ prisma: {} }));
vi.mock("../../telemetry/store", () => ({ createPrismaTelemetryStore: () => ({}) }));
vi.mock("../health/failedRuns", () => ({ readFailedRunLoad: reads.failedRuns }));
vi.mock("../health/memoryRebuilds", () => ({ readMemoryRebuildLoad: reads.memoryRebuilds }));
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
});
