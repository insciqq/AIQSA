import { describe, expect, it } from "vitest";
import {
  ANSWER_REVIEW_AUTO_DEFAULT,
  ANSWER_REVIEW_AUTO_MAX_RUNS,
  answerReviewExtraAnswers,
  answerReviewStopCopy,
  decodeAnswerReviewAutoConfig,
  decodeAnswerReviewSendRequest,
  decodeAnswerReviewSessionWire,
  sameAnswerReviewAutoConfig
} from "./answerReviews";
import { decodeCatalogResponse } from "./catalog";

const reviewer = { modelId: "model-b", provider: "connection-b" };
const second = { modelId: "model-c", provider: "connection-c" };

describe("automatic answer review contract", () => {
  it("decodes a chat's choice strictly: on needs a reviewer, at most two distinct ones, one to three rounds", () => {
    expect(decodeAnswerReviewAutoConfig({ enabled: true, maxRounds: 3, reviewers: [reviewer, second] }))
      .toEqual({ enabled: true, maxRounds: 3, reviewers: [reviewer, second] });
    // Off may keep its reviewers for the next time it is turned on, or none.
    expect(decodeAnswerReviewAutoConfig({ enabled: false, maxRounds: 1, reviewers: [] })).toEqual({ enabled: false, maxRounds: 1,
      reviewers: [] });
    for (const invalid of [
      { enabled: true, maxRounds: 3, reviewers: [] },
      { enabled: true, maxRounds: 4, reviewers: [reviewer] },
      { enabled: true, maxRounds: 0, reviewers: [reviewer] },
      { enabled: true, maxRounds: 2, reviewers: [reviewer, reviewer] },
      { enabled: true, maxRounds: 2, reviewers: [reviewer, second, { modelId: "model-d", provider: "connection-d" }] },
      { enabled: true, maxRounds: 2, reviewers: [{ ...reviewer, name: "GPT-5" }] },
      { enabled: "yes", maxRounds: 2, reviewers: [reviewer] },
      { enabled: true, extra: 1, maxRounds: 2, reviewers: [reviewer] }
    ]) {
      expect(decodeAnswerReviewAutoConfig(invalid), JSON.stringify(invalid)).toBeNull();
    }
    expect(ANSWER_REVIEW_AUTO_DEFAULT).toEqual({ enabled: false, maxRounds: 3, reviewers: [] });
  });

  it("decodes a send's review with each reviewer's own Search", () => {
    const searchPlan = { mode: "all_selected", optionIds: ["web"] };
    expect(decodeAnswerReviewSendRequest({ maxRounds: 2, reviewers: [{ ...reviewer, searchPlan }] }))
      .toEqual({ maxRounds: 2, reviewers: [{ ...reviewer, searchPlan }] });
    expect(decodeAnswerReviewSendRequest({ maxRounds: 2, reviewers: [] })).toBeNull();
    expect(decodeAnswerReviewSendRequest({ maxRounds: 2, reviewers: [reviewer] })).toBeNull();
    expect(decodeAnswerReviewSendRequest({ enabled: true, maxRounds: 2, reviewers: [{ ...reviewer, searchPlan }] })).toBeNull();
    expect(decodeAnswerReviewSendRequest({ maxRounds: 2, reviewers: [{ ...reviewer, searchPlan: { mode: "x", optionIds: [] } }] }))
      .toBeNull();
  });

  it("counts the extra answers a choice can cost and the session's run ceiling", () => {
    expect(answerReviewExtraAnswers({ maxRounds: 3, reviewers: [reviewer] })).toBe(6);
    expect(answerReviewExtraAnswers({ maxRounds: 3, reviewers: [reviewer, second] })).toBe(9);
    expect(answerReviewExtraAnswers({ maxRounds: 1, reviewers: [] })).toBe(2);
    expect(ANSWER_REVIEW_AUTO_MAX_RUNS).toBe(10);
  });

  it("compares choices by value", () => {
    const config = { enabled: true, maxRounds: 2 as const, reviewers: [reviewer] };
    expect(sameAnswerReviewAutoConfig(config, { ...config, reviewers: [{ ...reviewer }] })).toBe(true);
    expect(sameAnswerReviewAutoConfig(config, { ...config, maxRounds: 3 })).toBe(false);
    expect(sameAnswerReviewAutoConfig(config, { ...config, reviewers: [second] })).toBe(false);
  });

  it("names how an automatic session stopped", () => {
    expect(answerReviewStopCopy("time_limit")).toContain("30-minute");
    expect(answerReviewStopCopy("unsupported")).toContain("generated images");
    const wire = {
      author: { modelId: "model-a", name: "Claude", provider: "connection-a" }, id: "session-1", maxRounds: 3, mode: "auto",
      reviewers: [{ ...reviewer, name: "GPT-5" }], round: 1, sourceAssistantMessageId: "answer-1", state: "stopped",
      stopReason: "time_limit"
    };
    expect(decodeAnswerReviewSessionWire(wire)).toMatchObject({ mode: "auto", stopReason: "time_limit" });
  });

  it("carries the Settings default on the catalog and refuses a malformed one", () => {
    const catalog = (answerReview: unknown) => ({ catalog: {
      defaults: { answerReview, controlValues: {}, hasPersonalModelDefault: false, modelId: "m", modelPreferenceSource: "none",
        organizationModelDefault: null, organizationSearchPlan: { mode: "all_selected", optionIds: [] }, personalModelDefault: null,
        provider: "p", searchPlan: { mode: "all_selected", optionIds: [] }, searchPreferenceSource: "personal", showCitations: true,
        showReasoningBlocks: false },
      models: [], providers: [], searchStrategies: []
    } });
    expect(decodeCatalogResponse(catalog({ enabled: true, maxRounds: 2, reviewers: [reviewer] }))?.defaults.answerReview)
      .toEqual({ enabled: true, maxRounds: 2, reviewers: [reviewer] });
    expect(decodeCatalogResponse(catalog(undefined))?.defaults.answerReview).toBeUndefined();
    expect(decodeCatalogResponse(catalog({ enabled: true, maxRounds: 2, reviewers: [] }))).toBeNull();
  });
});
