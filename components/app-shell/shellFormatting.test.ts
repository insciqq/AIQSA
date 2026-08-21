import { describe, expect, it } from "vitest";
import type { CatalogModel } from "./types";
import { exportFileBaseName, formatTokenCount, humanizeErrorCode, modelCapabilityDescription, modelCapabilityLabel, modelCapabilityLabels, responseErrorMessage } from "./shellFormatting";

describe("shell error formatting", () => {
  it("turns known code families into readable messages while keeping the raw code", () => {
    expect(humanizeErrorCode("send_failed_400")).toBe(
      "Send failed with HTTP 400 (send_failed_400)"
    );
    expect(humanizeErrorCode("share_failed_500")).toBe(
      "Share failed with HTTP 500 (share_failed_500)"
    );
    expect(humanizeErrorCode("active_run_in_progress")).toContain(
      "(active_run_in_progress)"
    );
    expect(humanizeErrorCode("branch_checkout_failed")).toBe(
      "Opening this version failed (branch_checkout_failed)"
    );
    expect(humanizeErrorCode("branch_checkout_failed_409")).toBe(
      "Open version failed with HTTP 409 (branch_checkout_failed_409)"
    );
    expect(humanizeErrorCode("mcp_tool_calling_not_supported")).toBe(
      "Choose a model with tool calling to use MCP (mcp_tool_calling_not_supported)"
    );
    expect(humanizeErrorCode("mcp_not_ready")).toBe(
      "An enabled MCP server or tool is no longer ready. Review MCP settings and try again (mcp_not_ready)"
    );
    expect(humanizeErrorCode("mcp_selection_invalid")).toBe(
      "Choose Auto, Load all, or Off for MCP tools and try again (mcp_selection_invalid)"
    );
    expect(humanizeErrorCode("mcp_auto_discovery_unavailable")).toBe(
      "Automatic tool discovery is unavailable. Retry in Auto or use Load all (mcp_auto_discovery_unavailable)"
    );
    expect(humanizeErrorCode("structured_output_not_supported")).toBe(
      "The selected System Model does not have verified structured output (structured_output_not_supported)"
    );
    expect(humanizeErrorCode("skill_not_available")).toBe(
      "A selected Skill is no longer available. Review Skills and try again (skill_not_available)"
    );
  });

  it("leaves already-readable provider messages unchanged", () => {
    expect(humanizeErrorCode("OpenAI request failed with status 503")).toBe(
      "OpenAI request failed with status 503"
    );
  });

  it.each([
    ["sources_processing", "still processing"],
    ["no_retrieval_candidates", "No matching passages"],
    ["knowledge_retrieval_failed", "could not be retrieved"],
    ["knowledge_answer_failed", "could not complete"],
    ["knowledge_answer_contract_failed", "could not be safely accepted"],
    ["knowledge_citation_contract_failed", "cited evidence that was not supplied"]
  ])("keeps Knowledge state %s distinct and user-safe", (code, expected) => {
    const message = humanizeErrorCode(code);
    expect(message).toContain(expected);
    expect(message).toContain(`(${code})`);
    expect(message).not.toMatch(/providerResponseId|manifestHash|sourceArtifactId/u);
  });

  it("prefers structured API errors and preserves plain response text", async () => {
    await expect(
      responseErrorMessage(
        Response.json({ error: "chat_delete_failed_409" }, { status: 409 }),
        "chat_delete_failed_409"
      )
    ).resolves.toBe("Chat deletion failed with HTTP 409 (chat_delete_failed_409)");
    await expect(
      responseErrorMessage(
        new Response("Readable upstream failure", { status: 502 }),
        "send_failed_502"
      )
    ).resolves.toBe("Readable upstream failure");
    await expect(
      responseErrorMessage(new Response("", { status: 500 }), "send_failed_500")
    ).resolves.toBe("Send failed with HTTP 500 (send_failed_500)");
  });

  it("uses only allowlisted bounded attachment-limit messages from run admission", async () => {
    await expect(
      responseErrorMessage(
        Response.json(
          {
            error: "attachment_count_limit_exceeded",
            message: "This run contains 24 attachments; the limit is 20."
          },
          { status: 413 }
        ),
        "send_failed_413"
      )
    ).resolves.toBe("This run contains 24 attachments; the limit is 20.");

    await expect(
      responseErrorMessage(
        Response.json(
          {
            error: "provider_unavailable",
            message: "Untrusted provider copy"
          },
          { status: 503 }
        ),
        "send_failed_503"
      )
    ).resolves.toBe("provider unavailable (provider_unavailable)");
  });
});

describe("shell labels", () => {
  const model: CatalogModel = {
    capabilities: {
      background: true,
      documentInputMode: "native_pdf",
      imageInput: true,
      nativeWebSearch: true,
      openRouterPerplexitySearch: false,
      reasoning: true,
      streaming: true,
      toolCalling: true
    },
    contextWindow: 128000,
    defaultParams: {},
    displayName: "GPT",
    modelId: "gpt",
    parameterControls: {
      background: { defaultValue: true, supported: true },
      maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["none", "medium"],
        supported: true
      },
      stream: { defaultValue: false, supported: false },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "openai",
    searchStrategyIds: ["search-disabled", "openai-native-web-search"]
  };

  it("preserves two decimal places when a million-token limit needs them", () => {
    expect(formatTokenCount(1_000_000)).toBe("1m");
    expect(formatTokenCount(1_050_000)).toBe("1.05m");
    expect(formatTokenCount(999_999)).toBe("1m");
  });

  it("keeps capability ordering stable", () => {
    expect(modelCapabilityLabel(model)).toBe("reasoning / vision / pdf / search / stream");
    expect(modelCapabilityDescription(model)).toBe(
      "Reasoning · Images · PDF and documents · Web search · Streaming"
    );
    expect(modelCapabilityLabels(model)).toEqual([
      "Reasoning",
      "Images",
      "PDF and documents",
      "Web search",
      "Streaming"
    ]);
  });

  it("builds deterministic export base names from the title slug and ISO date", () => {
    const date = new Date("2026-08-13T15:30:00.000Z");

    expect(exportFileBaseName("Release checklist · 032", date)).toBe(
      "release-checklist-032-2026-08-13"
    );
    // Unicode titles keep their letters instead of collapsing to a fallback.
    expect(exportFileBaseName("Исследование памяти", date)).toBe(
      "исследование-памяти-2026-08-13"
    );
    expect(exportFileBaseName("///", date)).toBe("chat-2026-08-13");
    expect(exportFileBaseName(`${"a".repeat(80)} tail`, date)).toBe(
      `${"a".repeat(64)}-2026-08-13`
    );
  });
});
