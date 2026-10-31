import { afterEach, describe, expect, it } from "vitest";
import { setRunProviderWait } from "./providerWaits";
import { serializeRunOutcome } from "./runOutcome";
import type { RunOutcomeRecord } from "./runRepositoryContract";

describe("run outcome provider wait", () => {
  const record = { id: "run-1", status: "streaming" } as RunOutcomeRecord;
  afterEach(() => setRunProviderWait("run-1", null));

  it("reports the run's own wait and drops it when the provider answers", () => {
    expect(serializeRunOutcome(record).run).not.toHaveProperty("providerWait");
    setRunProviderWait("run-1", "retrying");
    expect(serializeRunOutcome(record).run.providerWait).toBe("retrying");
    expect(serializeRunOutcome({ ...record, id: "run-2" }).run).not.toHaveProperty("providerWait");
    setRunProviderWait("run-1", null);
    expect(serializeRunOutcome(record).run).not.toHaveProperty("providerWait");
  });
});
