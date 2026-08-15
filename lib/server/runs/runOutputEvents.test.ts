import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  isRunOutputArtifactEvent,
  projectRunOutputArtifactEvent,
  runOutputArtifactEvents
} from "./runOutputEvents";

describe("durable run output events", () => {
  it("projects citations and reasoning into output-only shapes", () => {
    const citation = projectRunOutputArtifactEvent({
      data: {
        artifactType: "citation",
        payload: {
          index: 3,
          providerCallId: "private-call-id",
          routeId: "private-route",
          snippet: " A bounded excerpt. ",
          source: " Hosted Search ",
          title: " Source title ",
          type: "url_citation",
          url: "https://example.com/source"
        }
      },
      type: "artifact"
    });
    const reasoning = projectRunOutputArtifactEvent({
      data: {
        artifactType: "reasoning",
        payload: {
          id: "private-reasoning-id",
          summary: [
            { text: "Compared the sources.", type: "summary_text" },
            { text: "Checked the conclusion.", type: "summary_text" }
          ],
          type: "reasoning"
        }
      },
      type: "artifact"
    });

    expect(citation).toEqual({
      data: {
        artifactType: "citation",
        payload: {
          index: 3,
          snippet: "A bounded excerpt.",
          source: "Hosted Search",
          title: "Source title",
          url: "https://example.com/source"
        }
      },
      type: "artifact"
    });
    expect(reasoning).toEqual({
      data: {
        artifactType: "reasoning",
        payload: { text: "Compared the sources.\n\nChecked the conclusion." }
      },
      type: "artifact"
    });
    expect(JSON.stringify([citation, reasoning])).not.toMatch(
      /private-call-id|private-route|private-reasoning-id|summary_text|url_citation/
    );
    expect(citation && isRunOutputArtifactEvent(citation)).toBe(true);
    expect(reasoning && isRunOutputArtifactEvent(reasoning)).toBe(true);
  });

  it("retains only normalized safe sources from hosted-search events", () => {
    const rawEvent: ModelRunSseEvent = {
      data: {
        artifactType: "search",
        payload: {
          action: {
            query: "private generated query",
            sources: [
              {
                description: "Safe source summary",
                providerMetadata: "private-source-metadata",
                title: "Hosted source",
                url: "https://example.com/hosted"
              },
              { title: "Unsafe source", url: "javascript:alert(1)" }
            ],
            type: "search"
          },
          id: "private-provider-call",
          responseId: "private-response-id",
          status: "completed",
          type: "web_search_call"
        }
      },
      type: "artifact"
    };

    const output = projectRunOutputArtifactEvent(rawEvent);

    expect(output).toEqual({
      data: {
        artifactType: "search",
        payload: {
          action: {
            sources: [{
              rank: 1,
              snippet: "Safe source summary",
              title: "Hosted source",
              url: "https://example.com/hosted"
            }]
          }
        }
      },
      type: "artifact"
    });
    expect(output && isRunOutputArtifactEvent(output)).toBe(true);
    expect(isRunOutputArtifactEvent(rawEvent)).toBe(false);
    expect(JSON.stringify(output)).not.toMatch(
      /private generated query|private-source-metadata|private-provider-call|private-response-id|javascript:/
    );
  });

  it("drops lifecycle, query-only Search, and opaque reasoning artifacts", () => {
    expect(runOutputArtifactEvents([
      { data: { delta: "answer" }, type: "token" },
      {
        data: {
          artifactType: "search",
          payload: { action: { query: "private query" }, id: "search-1" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "reasoning",
          payload: { encryptedContent: "private reasoning state", id: "reasoning-1" }
        },
        type: "artifact"
      },
      {
        data: { artifactType: "tool_result", payload: { private: true } },
        type: "artifact"
      }
    ])).toEqual([]);
  });
});
