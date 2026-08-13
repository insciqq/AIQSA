import { describe, expect, it } from "vitest";
import {
  projectRunDetailsV2,
  runMatchesTargetV2,
  safeRunPreviewJson
} from "./runDetailsModel";
import {
  completeRunDetailsFixture,
  emptyRunDetailsFixture,
  memoryRunDetailsFixture,
  runDetailsCatalogFixture,
  runDetailsGeneratedFileFacts,
  runDetailsTargetFixture
} from "./fixtures";

describe("run details v2 projection", () => {
  it("binds exact accepted evidence while omitting ids, raw content, secrets, and estimated cost", () => {
    const projection = projectRunDetailsV2({
      catalog: runDetailsCatalogFixture,
      generatedFiles: runDetailsGeneratedFileFacts,
      run: completeRunDetailsFixture,
      target: runDetailsTargetFixture
    });

    expect(projection).not.toBeNull();
    expect(projection?.bindings).toEqual(expect.arrayContaining([
      { label: "Provider", value: "OpenAI · рабочий ключ" },
      { label: "Model", value: "GPT-5.2" },
      { label: "Search", value: "Research Search" },
      { label: "Knowledge", value: "1 base" },
      { label: "Input files", value: "2 · private" }
    ]));
    expect(projection?.usage).toMatchObject({ inputTokens: 4_312, outputTokens: 1_208 });
    expect(projection).not.toHaveProperty("estimatedCostMicros");
    expect(projection?.generatedFiles.map((file) => file.name)).toEqual([
      "report_q3.xlsx",
      "deck_q3.pptx"
    ]);
    expect(projection?.requestPreview).toContain('"messages": [\n    "‹redacted›"');
    expect(projection?.requestPreview).toContain('"attachments": [\n    "‹private›"');
    expect(projection?.tools[0]?.argumentsPreview).toContain('"api_key": "‹redacted›"');
    expect(projection?.tools[0]?.resultPreview).toContain('"authorization": "‹redacted›"');

    const visibleProjection = JSON.stringify({
      bindings: projection?.bindings,
      generatedFiles: projection?.generatedFiles,
      knowledge: projection?.knowledge,
      parameters: projection?.parameters,
      requestPreview: projection?.requestPreview,
      searchAttempts: projection?.searchAttempts,
      timeline: projection?.timeline,
      tools: projection?.tools,
      usage: projection?.usage
    });
    expect(visibleProjection).not.toMatch(
      /private-key|private-bearer|tool-call-private|knowledge-base-private|search-option-private|search-provider-private|assistant-message-private|run-private/u
    );
    expect(visibleProjection).not.toContain("private answer text never appears");
  });

  it("keeps frozen Memory text and lifecycle facts without a stale deleted-source target", () => {
    const projection = projectRunDetailsV2({
      catalog: runDetailsCatalogFixture,
      run: memoryRunDetailsFixture,
      target: runDetailsTargetFixture
    });
    expect(projection?.memory?.outcome).toBe("Used with safe degradation");
    expect(projection?.memory?.action).toEqual({
      label: "Updated",
      statement: "Предпочитает отчёты в XLSX и суммы в рублях."
    });
    const deleted = projection?.memory?.items.find((item) => item.lifecycle === "Source deleted");
    expect(deleted).toMatchObject({
      includedText: expect.stringContaining("удалённом исходном чате"),
      sourceChatId: null
    });
    const live = projection?.memory?.items.find((item) => item.sourceMessageCount === 2);
    expect(live?.sourceChatId).toBe("source-chat-private-live");
    expect(projection?.memory?.items.some((item) => item.lifecycle === "Later forgotten")).toBe(true);
  });

  it("shows no Usage section from an estimate when provider token evidence is absent", () => {
    const projection = projectRunDetailsV2({
      catalog: runDetailsCatalogFixture,
      run: emptyRunDetailsFixture,
      target: runDetailsTargetFixture
    });
    expect(emptyRunDetailsFixture.estimatedCostMicros).toBeGreaterThan(0);
    expect(projection?.usage).toBeNull();
    expect(projection?.timeline).toEqual([]);
  });

  it("rejects cross-answer and cross-run receipts", () => {
    expect(runMatchesTargetV2(completeRunDetailsFixture, runDetailsTargetFixture)).toBe(true);
    expect(projectRunDetailsV2({
      catalog: runDetailsCatalogFixture,
      run: {
        ...completeRunDetailsFixture,
        inspection: {
          ...completeRunDetailsFixture.inspection!,
          answerMessageId: "another-answer-private"
        }
      },
      target: runDetailsTargetFixture
    })).toBeNull();
    expect(projectRunDetailsV2({
      catalog: runDetailsCatalogFixture,
      run: completeRunDetailsFixture,
      target: { ...runDetailsTargetFixture, runId: "another-run-private" }
    })).toBeNull();
  });

  it("bounds recursive previews and redacts common credential forms", () => {
    const circular: Record<string, unknown> = {
      authorization: "Bearer should-never-render",
      nested: { password: "private-password", value: "sk-private-provider-key" },
      text: "x".repeat(3_000)
    };
    circular.circular = circular;
    const preview = safeRunPreviewJson(circular, 900);
    expect(preview?.length).toBeLessThanOrEqual(900);
    expect(preview).toContain("‹redacted›");
    expect(preview).toContain("‹circular value omitted›");
    expect(preview).not.toMatch(/should-never-render|private-password|private-provider-key/u);
  });
});
