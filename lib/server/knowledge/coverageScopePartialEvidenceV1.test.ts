import { describe, expect, it } from "vitest";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { knowledgeAnswerDraftPromptV40 } from "./answerGroundingSnapshotV40";
import { knowledgeCoverageScopePromptV7, knowledgeCoverageScopeCompletenessPromptV2 } from "./coverageScopePromptV7";

const input = { request: "Report the reading.", evidence: [{ handle: "K1", exactExcerpt: "The reading is 18 units." }],
  evidenceManifest: "Immutable evidence" };
const acceptedScope = { version: 7 as const, scope: [{ id: "D1", description: "Report the reading.",
  requestAnchor: "reading", evidenceAtomIds: ["A1"], evidenceHandles: ["K1"] }],
overflow: { pending: [], unparsedRemainder: false, version: 1 as const } };

describe("workflow-pinned Scope partial evidence instructions", () => {
  // Captured before workflow 7: accepted prompt bytes are recovery authority.
  it.each([
    [undefined, "6f15663a35addfb1efecf7ad9c4295425d745c6442b89a87106688e57fdc235c", "207ba1d7775bb0b4600eb6904fee7a76b20d58d3109195457f36d88fe10df5db", "dd46615bd162f91010d172ba52c5536d4f5202e1764d646d69f81e0ce6be785f"],
    [2, "3cd4bcbd3eef9370b643c70d5dc5deebfce24f9415eed320358a94851fa542f0", "cbc9c55511a5a865b4529910bc5085af8018bd2fe131056fce34abe6d786be98", "72cf99e7f62ffa53773632e9040697bbae8cd642f43e60c6a560553ba13e2a2f"],
    [3, "3cd4bcbd3eef9370b643c70d5dc5deebfce24f9415eed320358a94851fa542f0", "cbc9c55511a5a865b4529910bc5085af8018bd2fe131056fce34abe6d786be98", "72cf99e7f62ffa53773632e9040697bbae8cd642f43e60c6a560553ba13e2a2f"],
    [4, "98ece32318ab2c412162ae46988ffa99d8a78dac4f8e361499764b087fc434f4", "821089e735ab58aaf81f4285da8d5196229dfb92ace74a5b97dd294d8e16317d", "72cf99e7f62ffa53773632e9040697bbae8cd642f43e60c6a560553ba13e2a2f"],
    [5, "98ece32318ab2c412162ae46988ffa99d8a78dac4f8e361499764b087fc434f4", "821089e735ab58aaf81f4285da8d5196229dfb92ace74a5b97dd294d8e16317d", "72cf99e7f62ffa53773632e9040697bbae8cd642f43e60c6a560553ba13e2a2f"],
    [6, "8d12025c210d554672ace460e984606bc6608c63b022e64f29ba0a71f90fa752", "4bd5ca09af31d9b30e10790a3d86504fc72349cf658b9fcad59638df78c9dcd8", "72cf99e7f62ffa53773632e9040697bbae8cd642f43e60c6a560553ba13e2a2f"]
  ] as const)("retains exact historical prompt hashes for workflow %s", (workflowVersion, scopeHash, completenessHash, draftHash) => {
    const workflow = workflowVersion === undefined ? {} : { workflowVersion };
    expect(knowledgeAnswerHash(knowledgeCoverageScopePromptV7({ ...input, ...workflow, scopePass: "initial" }))).toBe(scopeHash);
    expect(knowledgeAnswerHash(knowledgeCoverageScopeCompletenessPromptV2({ ...input, ...workflow,
      acceptedScope, completenessPass: "initial" }))).toBe(completenessHash);
    expect(knowledgeAnswerHash(knowledgeAnswerDraftPromptV40({ ...workflow, draftPass: "primary",
      evidenceManifest: input.evidenceManifest, request: input.request,
      routeInstruction: "Answer only from supplied Knowledge evidence." }))).toBe(draftHash);
  });

  it("keeps partial binding independent of answer coverage without contradictory complete-only instructions", () => {
    const scope = knowledgeCoverageScopePromptV7({ ...input, scopePass: "initial", workflowVersion: 7 });
    const completeness = knowledgeCoverageScopeCompletenessPromptV2({ ...input, acceptedScope,
      completenessPass: "initial", workflowVersion: 7 });
    for (const prompt of [scope, completeness]) {
      expect(prompt.systemPrompt).toContain("Do not require the assigned atoms to entail the complete requested outcome");
      expect(prompt.systemPrompt).toContain("Preserve the full requested semantic operator");
      expect(prompt.systemPrompt).toContain("Selector independently decides truth, relevance and collective completeness");
      expect(prompt.systemPrompt).not.toContain("every atom ID needed to entail its complete conclusion");
      expect(prompt.systemPrompt).not.toContain("only materially distinct direct answer-bearing conclusions supported inside that unit");
      expect(JSON.parse(prompt.userPrompt).request).toBe(input.request);
    }
    expect(completeness.systemPrompt).toContain("never echo, delete, rewrite, merge, narrow, re-anchor or replace an accepted item");
    expect(completeness.systemPrompt).toContain("Do not append a duplicate unsupported copy");
    expect(JSON.parse(completeness.userPrompt).acceptedScope).toEqual(acceptedScope);
  });
});
