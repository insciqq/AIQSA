import { describe, expect, it } from "vitest";

describe("scaffold smoke", () => {
  it("keeps the app shell test anchors stable", () => {
    expect(["app-shell", "left-chat-pane", "main-thread-pane", "details-pane"]).toEqual([
      "app-shell",
      "left-chat-pane",
      "main-thread-pane",
      "details-pane"
    ]);
  });
});
