import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import failureCodes from "../../observability/failureCodes.json";

describe("background sub-agent log codes", () => {
  it("logs only codes the log projection keeps, never one that turns into unknown", () => {
    const directory = path.join(process.cwd(), "lib/server/runs/subagentBackground");
    const sources = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");
    const literal = [...sources.matchAll(/code: "(subagent_[a-z_]+)"/gu)].map((match) => match[1]!);
    // Codes built from a bounded vocabulary: the route stages and the wake-up outcomes.
    const built = [
      ...["summary", "threads", "thread", "stop", "stop_all"].map((stage) => `subagent_route_${stage}_failed`),
      ...["admitted", "busy", "stale", "usage_limited", "failed"].map((outcome) => `subagent_wake_up_${outcome}`)
    ];
    const logged = [...new Set([...literal.filter((code) => !/^subagent_(busy|limit_reached|usage_limited|background_unavailable)$/u
      .test(code)), ...built])];
    expect(logged.length).toBeGreaterThan(10);
    expect(logged.filter((code) => !(failureCodes as string[]).includes(code))).toEqual([]);
  });
});
