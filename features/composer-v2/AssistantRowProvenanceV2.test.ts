import { describe, expect, it } from "vitest";
import { chatHeaderGalleryAssistants, chatHeaderGalleryBound } from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import type { AssistantAvailabilityDependency, AssistantRowKey } from "@/lib/contracts/assistants";
import { assistantRowNoticeText, assistantRowProvenance, type BoundComposerAssistantV2 } from "./AssistantRowProvenanceV2";

const [hr] = chatHeaderGalleryAssistants;

/** The HR Helper with one row falling back, optionally naming what is missing. */
function fallbackLine(
  row: AssistantRowKey,
  dependencies?: AssistantAvailabilityDependency[]
): string | null {
  const bound = chatHeaderGalleryBound(hr!);
  const assistant = {
    ...bound,
    rows: {
      ...bound.rows,
      [row]: {
        ...bound.rows[row],
        deviation: { ...(dependencies ? { dependencies } : {}), reason: "tools_access" },
        origin: "fallback"
      }
    }
  } as BoundComposerAssistantV2;
  return assistantRowNoticeText(assistantRowProvenance(assistant, row));
}

describe("an Assistant row's fallback line", () => {
  it("agrees with a singular or plural row word", () => {
    expect(fallbackLine("model")).toBe("HR Helper's recommended model isn't available to you; using your default");
    expect(fallbackLine("tools")).toBe("HR Helper's MCP servers aren't available to you; using your default");
  });

  it("agrees with the names of the missing dependencies", () => {
    expect(fallbackLine("tools", [{ kind: "mcp", name: "Jira" }]))
      .toBe("HR Helper's Jira isn't available to you; using your default");
    expect(fallbackLine("tools", [{ kind: "mcp", name: "Jira" }, { kind: "mcp", name: "GitHub" }]))
      .toBe("HR Helper's Jira, GitHub aren't available to you; using your default");
    expect(fallbackLine("tools", [{ kind: "mcp", name: "Required MCP tools" }]))
      .toBe("HR Helper's Required MCP tools aren't available to you; using your default");
  });
});
