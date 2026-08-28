import { describe, expect, it } from "vitest";
import {
  MEMORY_TOOL_EVENT_MAX_SAFE_TEXT_LENGTH,
  projectMemoryToolEvent,
  type MemoryToolEventSource
} from "./toolEvents";

function source(
  overrides: Partial<MemoryToolEventSource> = {}
): MemoryToolEventSource {
  return {
    assistantMessageId: "assistant-message-1",
    branchGeneration: 2,
    chatId: "chat-1",
    completedAt: new Date("2026-08-28T12:34:56.000Z"),
    modelRunId: "run-1",
    modelRunToolCallId: "call-1",
    result: { status: "complete" },
    sourceAssistantId: null,
    sourceCallUpdatedAt: new Date("2026-08-28T12:34:57.000Z"),
    sourceFolderId: null,
    sourceRevision: 7,
    state: "complete",
    toolName: "calendar.create_event",
    userId: "user-1",
    ...overrides
  };
}

describe("projectMemoryToolEvent", () => {
  it("projects bounded typed success metadata without copying arbitrary payloads", () => {
    const projected = projectMemoryToolEvent(source({
      result: {
        body: "private document body",
        created_at: "2026-08-28T12:34:55Z",
        event_title: "Dentist",
        operation: "create",
        status: "complete"
      }
    }));

    expect(projected).toMatchObject({
      languageCode: "und",
      operation: "create",
      outcome: "SUCCESS",
      structuredIdentifiers: {
        created_at: "2026-08-28T12:34:55Z",
        event: "Dentist",
        status: "complete"
      },
      toolName: "calendar.create_event"
    });
    expect(projected?.safeProjectedText).toContain("event: Dentist");
    expect(projected?.safeProjectedText).not.toContain("private document body");
  });

  it("keeps safe endpoint failure facts while stripping URL credentials and query", () => {
    const projected = projectMemoryToolEvent(source({
      result: {
        endpoint: "https://alice:password@example.test/v1/items?token=secret#fragment",
        error_code: "rate_limited",
        status_code: 429
      },
      toolName: "http.request"
    }));

    expect(projected).toMatchObject({
      outcome: "FAILURE",
      structuredIdentifiers: {
        endpoint: "https://example.test/v1/items",
        error_code: "rate_limited",
        status_code: "429"
      }
    });
    expect(projected?.safeProjectedText).not.toContain("password");
    expect(projected?.safeProjectedText).not.toContain("token=secret");
  });

  it("classifies a settled migration error from governed result fields", () => {
    const projected = projectMemoryToolEvent(source({
      result: {
        error_code: "duplicate_column",
        name: "add_customer_region",
        operation: "migrate",
        status: "failed"
      },
      toolName: "database.migrate"
    }));

    expect(projected).toMatchObject({
      operation: "migrate",
      outcome: "FAILURE",
      structuredIdentifiers: {
        error_code: "duplicate_column",
        name: "add_customer_region",
        status: "failed"
      }
    });
  });

  it("excludes secret-only recognized metadata and internal Memory tools", () => {
    expect(projectMemoryToolEvent(source({
      result: { name: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" }
    }))).toBeNull();
    expect(projectMemoryToolEvent(source({ toolName: "search_my_history" }))).toBeNull();
    expect(projectMemoryToolEvent(source({ toolName: "find_tools" }))).toBeNull();
  });

  it("detects secret-only arbitrary fields and audits dropped mixed-result secrets", () => {
    expect(projectMemoryToolEvent(source({
      result: { body: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" }
    }))).toBeNull();

    const projected = projectMemoryToolEvent(source({
      result: {
        api_token: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        filename: "safe-report.csv"
      },
      toolName: "filesystem.write"
    }));
    expect(projected).toMatchObject({
      redactionReasonCodes: ["SECRET_FIELD_DROPPED"],
      redactionState: "REDACTED",
      structuredIdentifiers: { filename: "safe-report.csv" }
    });
    expect(projected?.normalizedSafeSearchText).toContain("safe report csv");
    expect(JSON.stringify(projected)).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
    );
  });

  it("never indexes huge arbitrary bodies and remains deterministically bounded", () => {
    const projected = projectMemoryToolEvent(source({
      result: {
        body: "<html>" + "private ".repeat(50_000) + "</html>",
        filename: "migration.sql",
        status: "partial"
      },
      toolName: "filesystem.write"
    }));

    expect(projected?.outcome).toBe("PARTIAL");
    expect(projected?.safeProjectedText).toContain("filename: migration.sql");
    expect(projected?.safeProjectedText.length).toBeLessThanOrEqual(
      MEMORY_TOOL_EVENT_MAX_SAFE_TEXT_LENGTH
    );
    expect(projected?.safeProjectedText).not.toContain("<html>");
    expect(projectMemoryToolEvent(source())?.id).toBe(projectMemoryToolEvent(source())?.id);
  });
});
