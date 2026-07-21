import { describe, expect, it } from "vitest";
import type { CatalogModel } from "./types";
import {
  eventLabel,
  formatTokenCount,
  humanizeErrorCode,
  modelCapabilityLabel,
  responseErrorMessage,
  safeDownloadName,
  searchStrategyDescription
} from "./shellFormatting";

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
  });

  it("leaves already-readable provider messages unchanged", () => {
    expect(humanizeErrorCode("OpenAI request failed with status 503")).toBe(
      "OpenAI request failed with status 503"
    );
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
      streaming: true
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
  });

  it("formats event state without exposing raw payloads", () => {
    expect(eventLabel({ data: { delta: "answer" }, type: "token" })).toBe(
      "answer text"
    );
    expect(eventLabel({ data: { status: "queued" }, type: "summary" })).toBe(
      "queued"
    );
    expect(
      eventLabel({ data: { artifactType: "citation" }, type: "artifact" })
    ).toBe("citation");
  });

  it("formats search strategies and safe ASCII download names", () => {
    expect(searchStrategyDescription("openai-native-web-search")).toBe(
      "OpenAI web_search"
    );
    expect(searchStrategyDescription("perplexity-tool-search")).toBe(
      "Perplexity tool"
    );
    expect(searchStrategyDescription("search-disabled")).toBe("No Search");
    expect(safeDownloadName("Architecture / Notes 2026")).toBe(
      "architecture-notes-2026"
    );
    expect(safeDownloadName("Исследование")).toBe("aiqsa-chat");
  });
});
