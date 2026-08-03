import { describe, expect, it } from "vitest";
import { normalizeSearchSources } from "./evidence";

describe("Search source evidence normalization", () => {
  it("rejects provider URLs carrying username or password credentials", () => {
    const sources = normalizeSearchSources([
      { title: "Safe source", url: "https://example.com/evidence" },
      { title: "Username", url: "https://PRIVATE_USER@example.com/private" },
      { title: "Password", url: "https://user:PRIVATE_PASSWORD@example.com/private" }
    ]);

    expect(sources).toEqual([{
      rank: 1,
      title: "Safe source",
      url: "https://example.com/evidence"
    }]);
    expect(JSON.stringify(sources)).not.toMatch(/PRIVATE_USER|PRIVATE_PASSWORD/u);
  });
});
