import { textFromContentBlocks, type ModelRunSseEvent } from "../../domain/modelRunEvents";
import { conversationPreview, textConversationForRequest } from "./context";
import type { ProviderAdapter, ProviderRunResult } from "./types";

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("provider_run_aborted");
    error.name = "AbortError";
    throw error;
  }
}

function fakeProviderTokenDelayMs(): number {
  const parsed = Number(process.env.AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.min(Math.round(parsed), 1000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createFakeProviderAdapter(): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      return {
        model: request.modelId,
        params: request.params,
        prompt: request.prompt,
        provider: "fake",
        replayedContext: conversationPreview(request),
        redactions: ["selected_skill_instructions"],
        searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
        text: textFromContentBlocks(request.content)
      };
    },
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const question = textFromContentBlocks(request.content) || "empty question";
      const priorUserMessages = textConversationForRequest(request).filter(
        (message, index, messages) =>
          message.role === "user" &&
          message.purpose !== "skill_context" &&
          index < messages.length - 1
      );
      const contextSuffix =
        priorUserMessages.length > 0
          ? `\nContext memory: ${priorUserMessages.map((message) => message.content).join(" | ")}`
          : "";
      const finalText = `Fake answer: ${question}${contextSuffix}`;
      const words = finalText.split(" ");
      const tokenDelayMs = fakeProviderTokenDelayMs();

      throwIfAborted(options.signal);
      yield {
        data: {
          artifactType: "summary",
          payload: {
            searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
            source: "fake-provider"
          }
        },
        type: "artifact"
      };

      for (const word of words) {
        if (tokenDelayMs > 0) {
          await wait(tokenDelayMs);
        }
        throwIfAborted(options.signal);
        yield {
          data: {
            delta: `${word} `
          },
          type: "token"
        };
      }

      const usage = {
        inputTokens: tokenEstimate(question),
        outputTokens: tokenEstimate(finalText),
        reasoningTokens: 0
      };
      const normalizedUsage = {
        ...usage,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: usage.inputTokens + usage.outputTokens
      };

      return {
        finalProviderResponsePreview: {
          finishReason: "stop",
          provider: "fake",
          text: finalText
        },
        finalText,
        usage: normalizedUsage
      };
    }
  };
}
