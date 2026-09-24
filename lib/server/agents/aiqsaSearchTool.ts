import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { NormalizedSearchPlan, NormalizedSearchPlanOption } from "../providers/types";
import { createSearchPlanToolRouter, searchExecutionConfiguration } from "../search/toolExecutor";
import type { createAgentRunStore } from "./store";
import { AgentExecutionError } from "./failures";
import { captureSearchObservation, type ToolObservationService } from "../toolObservations/sourceAdapters";

export function createAgentAiqsaSearch(input: Readonly<{
  plan: NormalizedSearchPlan;
  store: Pick<ReturnType<typeof createAgentRunStore>, "assertActive" | "reserveProvider" | "settleProvider" | "failure">;
  resolve(option: NormalizedSearchPlanOption): Promise<ProviderRuntimeBinding>;
  assertAllowed(option: NormalizedSearchPlanOption): Promise<void>;
  onUsage(): Promise<void>;
  observation?: Readonly<{ service: ToolObservationService; runId: string; userId: string }>;
}>) {
  const options = input.plan.options;
  if (!options.length) return null;
  if (options.some((option) => option.adapterKind !== "provider_model_client")) throw new Error("agent_search_binding_invalid");
  const aliases = options.map((_, index) => `source_${index + 1}`);
  const choice = input.plan.mode === "model_choice";
  const configurations = options.map(searchExecutionConfiguration);
  const queryLimit = Math.min(...configurations.map((config) => config.queryMaxCharacters));
  return {
    timeoutSeconds: Math.ceil(Math.max(...configurations.map((config) => config.timeoutMs)) / 1000),
    description: choice
      ? `Search one selected source with a concise query. Sources: ${options.map((option, index) =>
        `${aliases[index]} = ${JSON.stringify(option.displayName?.slice(0, 160) || "Search source")}`).join("; ")}.`
      : "Search every user-selected source with a concise query and return findings and attributed links.",
    schema: {
      type: "object", additionalProperties: false,
      properties: { query: { type: "string", minLength: 1, maxLength: queryLimit },
        ...(choice ? { source: { type: "string", enum: aliases } } : {}) },
      required: choice ? ["query", "source"] : ["query"]
    },
    async execute(args: Record<string, unknown>, callId: string, signal: AbortSignal): Promise<CallToolResult> {
      const index = choice ? aliases.indexOf(String(args.source)) : -1;
      if (choice && index < 0) throw new Error("search_tool_not_selected");
      const selected = choice ? [options[index]!] : options;
      const runtimes: Record<string, ProviderRuntimeBinding | undefined> = {};
      await Promise.all(selected.map(async (option) => {
        try {
          await input.assertAllowed(option);
          const runtime = await input.resolve(option);
          if (!runtime.searchAdapter) return;
          const adapter = runtime.searchAdapter;
          runtimes[option.optionId] = { ...runtime, searchAdapter: {
            buildRequestPreview: (request) => adapter.buildRequestPreview(request),
            search: (request, searchOptions) => adapter.search(request, {
              ...searchOptions,
              async dispatch(attempt) {
                signal.throwIfAborted();
                await input.store.assertActive();
                await input.assertAllowed(option);
                const config = searchExecutionConfiguration(option);
                const id = await input.store.reserveProvider(Buffer.byteLength(JSON.stringify(attempt.body)) + config.maxOutputTokens, {
                  kind: "aiqsa_search", optionId: option.optionId, invocationId: callId, maxCalls: config.maxSearchCallsPerAnswer
                });
                let settled = false;
                try {
                  signal.throwIfAborted();
                  await input.store.assertActive();
                  const response = await attempt.execute();
                  await input.store.settleProvider(id, "COMPLETE", attempt.usage(response));
                  settled = true;
                  return response;
                } finally {
                  if (!settled) await input.store.settleProvider(id, "UNKNOWN", null);
                  await input.onUsage();
                }
              }
            })
          } };
        } catch {
          // The existing router reports unavailable sources and keeps successful
          // fan-out evidence. It never chooses a replacement destination.
          runtimes[option.optionId] = undefined;
        }
      }));
      const router = createSearchPlanToolRouter({ plan: input.plan, runtimes })!;
      const name = choice ? `search_engine_${index + 1}` : "search_selected_engines";
      const call = { id: callId, name, arguments: { query: args.query } };
      const execute = () => router.execute(call, undefined, { signal,
        ...(input.observation ? { retainOriginal: true as const } : {}) });
      const result = input.observation ? await captureSearchObservation({ service: input.observation.service,
        producer: { runId: input.observation.runId, userId: input.observation.userId, toolCallId: callId }, signal },
        { ...call, name: "aiqsa_search" }, selected.map(({ optionId, revisionId }) => ({ optionId, revisionId })), execute)
        : await execute();
      const failure = await input.store.failure();
      if (failure) throw new AgentExecutionError(failure);
      return { content: result.content.map((part) => ({ type: "text" as const,
        text: part.type === "text" ? part.text : JSON.stringify(part.value) })),
        ...(result.status === "error" ? { isError: true } : {}) };
    }
  };
}
