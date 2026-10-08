import { describe, expect, it, vi } from "vitest";
import { resolveAnswerReviewAuto } from "./autoAdmission";

type Prepared = Parameters<typeof resolveAnswerReviewAuto>[1]["prepared"];

function prepared(overrides: Readonly<{
  agent?: boolean; assistant?: boolean; knowledge?: boolean; projectModelIds?: readonly string[]; toolCalling?: boolean;
}> = {}): Prepared {
  return {
    ...(overrides.assistant ? { assistant: { assistantId: "assistant-1" } } : {}),
    normalizedRequest: {
      ...(overrides.agent ? { agent: { version: 2 } } : {}),
      knowledgePlan: { mode: overrides.knowledge ? "explicit" : "none" }
    },
    ...(overrides.projectModelIds ? { project: { modelIds: [...overrides.projectModelIds], projectId: "project-1" } } : {}),
    providerAdmissionPlan: {
      answer: {
        modelConfiguration: { capabilities: { toolCalling: overrides.toolCalling ?? true } },
        snapshot: { modelDisplayName: "  Claude  " }
      },
      selection: { providerConnectionId: "connection-a", providerModelId: "model-a" }
    }
  } as unknown as Prepared;
}

function admission(models: Record<string, Readonly<{ name: string; toolCalling: boolean }>>) {
  return {
    load: vi.fn(async (input: { providerModelId: string; executionScope?: string }) => {
      const model = models[input.providerModelId];
      if (!model) {
        const error = new Error("model_not_available");
        error.name = "ProviderAdmissionError";
        throw error;
      }
      return { answer: { modelConfiguration: { capabilities: { toolCalling: model.toolCalling } },
        snapshot: { modelDisplayName: model.name } } };
    })
  };
}

const reviewers = (...entries: Array<Readonly<{ modelId: string; provider: string }>>) => entries.map((entry) => ({
  ...entry, searchPlan: { mode: "all_selected", optionIds: ["reviewer-web"] }
}));
const body = (answerReview: unknown, extra: Record<string, unknown> = {}) => ({
  answerReview,
  mcp: { mode: "off" },
  modelId: "model-a",
  params: { temperature: 2 },
  provider: "connection-a",
  searchPlan: { mode: "all_selected", optionIds: ["author-web"] },
  timeZone: "Europe/Berlin",
  ...extra
});

describe("automatic review admission", () => {
  it("creates no session without a request", async () => {
    expect(await resolveAnswerReviewAuto({}, { body: { modelId: "model-a" }, prepared: prepared(), userId: "user-1" }))
      .toEqual({ ok: true });
  });

  it("freezes the answer's model, the admitted reviewers with their names, the rounds and the step controls", async () => {
    const providerAdmission = admission({ "model-b": { name: "GPT-5", toolCalling: true } });
    const resolved = await resolveAnswerReviewAuto({ providerAdmission: providerAdmission as never }, {
      body: body({ maxRounds: 2, reviewers: reviewers({ modelId: "model-b", provider: "connection-b" }) }),
      prepared: prepared(), userId: "user-1"
    });
    expect(resolved).toEqual({ auto: {
      authorModel: { modelId: "model-a", name: "Claude", provider: "connection-a" },
      controls: {
        controls: { mcp: { mode: "off" }, searchPlan: { mode: "all_selected", optionIds: ["author-web"] }, timeZone: "Europe/Berlin" },
        reviewerSearchPlans: [{ mode: "all_selected", optionIds: ["reviewer-web"] }],
        version: 1
      },
      maxRounds: 2,
      reviewers: [{ modelId: "model-b", name: "GPT-5", provider: "connection-b" }]
    }, ok: true });
    // The reviewer is admitted for this user, like a send of that model.
    expect(providerAdmission.load).toHaveBeenCalledWith(expect.objectContaining({ providerModelId: "model-b", userId: "user-1" }));
  });

  it("refuses an answer that cannot be reviewed with the reason the composer shows", async () => {
    const request = body({ maxRounds: 1, reviewers: reviewers({ modelId: "model-b", provider: "connection-b" }) });
    const deps = { providerAdmission: admission({ "model-b": { name: "GPT-5", toolCalling: true } }) as never };
    for (const [overrides, code] of [
      [{ assistant: true }, "answer_review_assistant_unsupported"],
      [{ agent: true }, "answer_review_agent_unsupported"],
      [{ knowledge: true }, "answer_review_knowledge_unsupported"],
      [{ toolCalling: false }, "answer_review_model_unsupported"]
    ] as const) {
      expect(await resolveAnswerReviewAuto(deps, { body: request, prepared: prepared(overrides), userId: "user-1" }), code)
        .toEqual({ code, ok: false, status: 409 });
    }
    expect(await resolveAnswerReviewAuto(deps, { body: { ...request, tools: "none" }, prepared: prepared(), userId: "user-1" }))
      .toMatchObject({ code: "answer_review_model_unsupported" });
  });

  it("never lets the answer's own model, a model without tools, an unavailable one or a non-Project one review", async () => {
    const deps = { providerAdmission: admission({
      "model-b": { name: "GPT-5", toolCalling: true }, "model-text": { name: "Text only", toolCalling: false }
    }) as never };
    for (const [entry, overrides] of [
      [{ modelId: "model-a", provider: "connection-a" }, {}],
      [{ modelId: "model-text", provider: "connection-t" }, {}],
      [{ modelId: "model-gone", provider: "connection-g" }, {}],
      [{ modelId: "model-b", provider: "connection-b" }, { projectModelIds: ["model-a"] }]
    ] as const) {
      expect(await resolveAnswerReviewAuto(deps, {
        body: body({ maxRounds: 1, reviewers: reviewers(entry) }), prepared: prepared(overrides), userId: "user-1"
      }), entry.modelId).toEqual({ code: "answer_review_reviewer_unavailable", ok: false, status: 409 });
    }
  });

  it("admits a Project's reviewers with the Project's shared authority", async () => {
    const providerAdmission = admission({ "model-b": { name: "GPT-5", toolCalling: true } });
    const resolved = await resolveAnswerReviewAuto({ providerAdmission: providerAdmission as never }, {
      body: body({ maxRounds: 1, reviewers: reviewers({ modelId: "model-b", provider: "connection-b" }) }),
      prepared: prepared({ projectModelIds: ["model-a", "model-b"] }), userId: "user-1"
    });
    expect(resolved.ok).toBe(true);
    expect(providerAdmission.load).toHaveBeenCalledWith(expect.objectContaining({ executionScope: "project" }));
  });

  it("refuses a malformed request", async () => {
    for (const answerReview of [null, { maxRounds: 5, reviewers: reviewers({ modelId: "model-b", provider: "connection-b" }) },
      { maxRounds: 1, reviewers: [] }, { enabled: true, maxRounds: 1, reviewers: [] }]) {
      expect(await resolveAnswerReviewAuto({}, { body: body(answerReview), prepared: prepared(), userId: "user-1" }))
        .toEqual({ code: "answer_review_invalid", ok: false, status: 400 });
    }
  });
});
