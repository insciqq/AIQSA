import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withPinnedHostedSearchIdentity(
  event: ModelRunSseEvent,
  request: Readonly<{ searchPlan?: ProviderRunRequest["searchPlan"] }>
): ModelRunSseEvent {
  if (event.type !== "artifact" || event.data.artifactType !== "search" ||
    !isRecord(event.data.payload) || event.data.payload.type !== "web_search_call") {
    return event;
  }
  const hosted = request.searchPlan?.options.find(
    (option) => option.adapterKind === "answer_provider_hosted"
  );
  if (!hosted) return event;
  return {
    data: {
      ...event.data,
      searchDisplayName: hosted.displayName?.trim() || "Search source",
      searchStrategy: hosted.optionId
    },
    type: "artifact"
  };
}
