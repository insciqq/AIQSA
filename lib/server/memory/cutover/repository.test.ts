import { describe, expect, it } from "vitest";
import { memoryCutoverAdmissionReason } from "./repository";

const none = Object.freeze({
  embedding: false,
  missing: false,
  pipeline: false,
  resume: false,
  revision: false,
  toolTextRepair: false
});

describe("memory cutover admission reason", () => {
  it.each([
    [{ missing: true, revision: true }, "missing_generation"],
    [{ pipeline: true, embedding: true, revision: true }, "pipeline_version"],
    [{ embedding: true, resume: true }, "embedding_model"],
    [{ resume: true, revision: true }, "resume"],
    [{ toolTextRepair: true, revision: true }, "tool_text_repair"],
    [{ revision: true }, "revision_lag"],
    [{}, "index_incomplete"]
  ] as const)("names %o as %s", (trigger, reason) => {
    expect(memoryCutoverAdmissionReason({ ...none, ...trigger })).toBe(reason);
  });

  it("treats an unreadable trigger as an incomplete index proof", () => {
    expect(memoryCutoverAdmissionReason({
      embedding: null,
      missing: null,
      pipeline: null,
      resume: null,
      revision: null,
      toolTextRepair: false
    })).toBe("index_incomplete");
  });
});
