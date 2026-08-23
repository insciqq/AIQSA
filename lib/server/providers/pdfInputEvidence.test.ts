import { describe, expect, it } from "vitest";
import {
  decodePdfInputVerificationEvidence,
  hasVerifiedPdfInput,
  pdfInputVerificationEvidence,
  pdfInputVerificationStatus
} from "./pdfInputEvidence";

const model = {
  adapterKind: "openai_responses_native" as const,
  capabilities: { nativePdfInput: true },
  upstreamModelId: "gpt-pdf"
};

describe("PDF input verification evidence", () => {
  it("creates and decodes only the current strict evidence shape", () => {
    const evidence = pdfInputVerificationEvidence(
      model.adapterKind,
      model.upstreamModelId
    );

    expect(evidence).toEqual({
      adapterKind: "openai_responses_native",
      probeVersion: 1,
      upstreamModelId: "gpt-pdf",
      verified: true
    });
    expect(decodePdfInputVerificationEvidence(evidence)).toEqual(evidence);
  });

  it.each([
    null,
    {},
    { adapterKind: "openai_responses_native", probeVersion: 2, upstreamModelId: "gpt-pdf", verified: true },
    { adapterKind: "openai_chat_completions_compatible", probeVersion: 1, upstreamModelId: "gpt-pdf", verified: true },
    { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "", verified: true },
    { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "gpt-pdf", verified: false }
  ])("rejects malformed or stale evidence %#", (value) => {
    expect(decodePdfInputVerificationEvidence(value)).toBeNull();
  });

  it("matches both adapter and upstream model inside the exact outer check", () => {
    const evidence = {
      pdfInput: pdfInputVerificationEvidence(model.adapterKind, model.upstreamModelId)
    };

    expect(hasVerifiedPdfInput(evidence, model)).toBe(true);
    expect(hasVerifiedPdfInput(evidence, {
      ...model,
      upstreamModelId: "another-model"
    })).toBe(false);
    expect(hasVerifiedPdfInput(evidence, {
      ...model,
      adapterKind: "openai_responses_compatible"
    })).toBe(false);
  });

  it("never makes a non-declared capability effective", () => {
    const evidence = {
      pdfInput: pdfInputVerificationEvidence(model.adapterKind, model.upstreamModelId)
    };

    expect(pdfInputVerificationStatus(evidence, model)).toBe("verified");
    expect(pdfInputVerificationStatus(evidence, {
      ...model,
      capabilities: { nativePdfInput: false }
    })).toBe("not_requested");
  });
});
