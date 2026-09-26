/**
 * Manual calibration of the context token estimate (lib/domain/tokenEstimate.ts)
 * against official provider counters. Never part of a test run.
 *
 * For every fixture of lib/domain/tokenEstimate.testFixtures.ts it prints the
 * character and o200k counts and, per configured provider model, the official
 * input-token count. Output is one JSON document of fixture names, classes,
 * model ids, counts and error codes only: no fixture text, keys or bodies.
 *
 * Environment (a provider without its key is skipped):
 * - ANTHROPIC_API_KEY: POST /v1/messages/count_tokens (free).
 *   AIQSA_CALIBRATION_ANTHROPIC_MODELS, default "claude-sonnet-5,claude-opus-5".
 * - GEMINI_API_KEY: models/{model}:countTokens (free).
 *   AIQSA_CALIBRATION_GEMINI_MODELS, default "gemini-3.6-flash".
 * - DEEPSEEK_API_KEY: one chat completion per fixture with max_tokens 1,
 *   reading usage.prompt_tokens (paid, about 14k input tokens per model).
 *   AIQSA_CALIBRATION_DEEPSEEK_MODELS, default "deepseek-flash".
 *
 * Each model also counts a one-character message ("."); `net` removes that
 * request overhead: net = raw - baseline + 1. The destinations are fixed
 * official HTTPS origins, so plain fetch without redirects replaces the
 * provider transport, whose diagnostics would interleave with the table.
 */
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { version as tokenizerVersion } from "gpt-tokenizer/package.json";
import { TOKEN_ESTIMATE_FIXTURES } from "../lib/domain/tokenEstimate.testFixtures";

type Provider = "anthropic" | "deepseek" | "gemini";
type Counter = Readonly<{ count(text: string): Promise<number>; model: string; provider: Provider }>;
type Count = Readonly<{ net: number; raw: number; ratio: number }> | Readonly<{ error: string }>;

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BASELINE_TEXT = ".";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

class CalibrationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const errorCode = (error: unknown) => error instanceof CalibrationError ? error.code : "unexpected";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new CalibrationError("invalid_count");
  return value;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CalibrationError("response_too_large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function postJson(url: string, headers: Readonly<Record<string, string>>, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new CalibrationError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
  }
  const text = await boundedText(response);
  if (!response.ok) throw new CalibrationError(`http_${response.status}`);
  try {
    return record(JSON.parse(text));
  } catch {
    throw new CalibrationError("invalid_json");
  }
}

function anthropic(apiKey: string, model: string): Counter {
  return {
    model,
    provider: "anthropic",
    count: async (text) => tokenCount((await postJson("https://api.anthropic.com/v1/messages/count_tokens",
      { "anthropic-version": "2023-06-01", "x-api-key": apiKey },
      { messages: [{ content: text, role: "user" }], model })).input_tokens)
  };
}

function gemini(apiKey: string, model: string): Counter {
  return {
    model,
    provider: "gemini",
    count: async (text) => tokenCount((await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`,
      { "x-goog-api-key": apiKey },
      { contents: [{ parts: [{ text }], role: "user" }] })).totalTokens)
  };
}

function deepseek(apiKey: string, model: string): Counter {
  return {
    model,
    provider: "deepseek",
    count: async (text) => tokenCount(record((await postJson("https://api.deepseek.com/chat/completions",
      { authorization: `Bearer ${apiKey}` },
      { max_tokens: 1, messages: [{ content: text, role: "user" }], model, stream: false })).usage).prompt_tokens)
  };
}

function models(variable: string, fallback: string): string[] {
  return (process.env[variable]?.trim() || fallback).split(",").map((model) => model.trim()).filter(Boolean);
}

const providers: ReadonlyArray<Readonly<{
  create(apiKey: string, model: string): Counter;
  defaults: string;
  key: string;
  models: string;
  provider: Provider;
}>> = [
  { create: anthropic, defaults: "claude-sonnet-5,claude-opus-5", key: "ANTHROPIC_API_KEY",
    models: "AIQSA_CALIBRATION_ANTHROPIC_MODELS", provider: "anthropic" },
  { create: gemini, defaults: "gemini-3.6-flash", key: "GEMINI_API_KEY",
    models: "AIQSA_CALIBRATION_GEMINI_MODELS", provider: "gemini" },
  { create: deepseek, defaults: "deepseek-flash", key: "DEEPSEEK_API_KEY",
    models: "AIQSA_CALIBRATION_DEEPSEEK_MODELS", provider: "deepseek" }
];

const reference = (text: string) => countTokens(text, { disallowedSpecial: new Set() });

async function main(): Promise<void> {
  const counts = new Map<string, Map<string, Count>>(TOKEN_ESTIMATE_FIXTURES.map((fixture) => [fixture.name, new Map()]));
  const measured: Record<string, unknown>[] = [];
  for (const entry of providers) {
    const apiKey = process.env[entry.key]?.trim();
    if (!apiKey) {
      measured.push({ provider: entry.provider, status: "skipped", reason: "no_key" });
      continue;
    }
    for (const model of models(entry.models, entry.defaults)) {
      if (!MODEL_ID.test(model)) {
        measured.push({ provider: entry.provider, status: "skipped", reason: "invalid_model_id" });
        continue;
      }
      const counter = entry.create(apiKey, model);
      const label = `${entry.provider}:${model}`;
      let baseline: number;
      try {
        baseline = await counter.count(BASELINE_TEXT);
      } catch (error) {
        measured.push({ error: errorCode(error), model, provider: entry.provider, status: "failed" });
        continue;
      }
      let failures = 0;
      for (const fixture of TOKEN_ESTIMATE_FIXTURES) {
        try {
          const raw = await counter.count(fixture.text);
          const net = raw - baseline + 1;
          counts.get(fixture.name)!.set(label, { net, raw, ratio: Math.round((net / reference(fixture.text)) * 1_000) / 1_000 });
        } catch (error) {
          failures += 1;
          counts.get(fixture.name)!.set(label, { error: errorCode(error) });
        }
      }
      measured.push({ baseline, failures, model, provider: entry.provider, status: failures === 0 ? "measured" : "partial" });
    }
  }
  process.stdout.write(`${JSON.stringify({
    version: 1,
    measuredAt: new Date().toISOString(),
    reference: { encoding: "o200k_base", package: "gpt-tokenizer", version: tokenizerVersion },
    providers: measured,
    fixtures: TOKEN_ESTIMATE_FIXTURES.map((fixture) => ({
      name: fixture.name,
      contentClass: fixture.contentClass,
      characters: [...fixture.text].length,
      o200k: reference(fixture.text),
      counts: Object.fromEntries(counts.get(fixture.name)!)
    }))
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`token estimate calibration failed: ${errorCode(error)}\n`);
  process.exitCode = 1;
});
