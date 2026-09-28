import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderRunResult } from "./types";

const nativeToolMarkup = "<｜DSML｜";

/** This delimiter belongs to DeepSeek's native tool protocol, not to the
 * structured Responses tool-call channel. Never interpret its arguments. */
class SynthesisTextGuard {
  private pending = "";
  forbidden = false;

  append(delta: string): string {
    if (this.forbidden) return "";
    const text = this.pending + delta;
    const marker = text.indexOf(nativeToolMarkup);
    if (marker >= 0) {
      this.pending = "";
      this.forbidden = true;
      return text.slice(0, marker);
    }
    // Retain only a possible delimiter prefix, even when SSE splits it into
    // individual characters. Ordinary answer text streams immediately.
    let retained = Math.min(text.length, nativeToolMarkup.length - 1);
    while (retained > 0 && !text.endsWith(nativeToolMarkup.slice(0, retained))) retained--;
    this.pending = text.slice(text.length - retained);
    return text.slice(0, text.length - retained);
  }

  finish(): string {
    const text = this.pending;
    this.pending = "";
    return text;
  }
}

/** Keep the completed provider result (and its exact usage) while rejecting
 * native tool markup before any token can reach the run publisher. */
export async function* guardDeepSeekSynthesis(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const guard = new SynthesisTextGuard();
  let publishedText = "";
  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "token") {
        const delta = guard.append(next.value.data.delta);
        if (delta) {
          publishedText += delta;
          yield { type: "token", data: { delta } };
        }
      } else yield next.value;
      next = await stream.next();
    }
    const result = next.value;
    // Non-streaming responses and SSE terminal-only text need the same check.
    // The shared parser may normalize final text independently of its deltas.
    const finalMarker = result.finalText.indexOf(nativeToolMarkup);
    if (guard.forbidden || finalMarker >= 0) {
      const finalText = finalMarker >= 0 ? result.finalText.slice(0, finalMarker) : publishedText;
      return {
        ...result,
        finalText,
        finalProviderResponsePreview: {
          id: result.providerResponseId,
          provider: "deepseek",
          status: "completed",
          text: finalText,
          usage: result.usage
        },
        synthesisToolCallForbidden: true
      };
    }
    const remaining = guard.finish();
    if (remaining) yield { type: "token", data: { delta: remaining } };
    return result;
  } finally {
    await stream.return(undefined as never).catch(() => undefined);
  }
}
