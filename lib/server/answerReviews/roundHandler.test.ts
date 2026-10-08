import { describe, expect, it, vi } from "vitest";

// Starting a round runs nothing: its route must not load (or compile) the run pipeline.
vi.mock("../runs/handlers", () => {
  throw new Error("the answer review round route loaded the run pipeline");
});
vi.mock("../runs/defaultSendMessageDeps", () => {
  throw new Error("the answer review round route loaded the send services");
});

describe("answer review round route", () => {
  it("loads without the run pipeline", async () => {
    const { createAnswerReviewRoundHandler } = await import("./roundHandler");
    expect(typeof createAnswerReviewRoundHandler).toBe("function");
  });
});
