import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createFetchOpenAICompatibleChatClient,
  createOpenAICompatibleChatAdapter
} from "../lib/server/providers/openaiCompatibleChat";
import type {
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult
} from "../lib/server/providers/types";

const LOOPBACK_HOST = "127.0.0.1";
const MANUAL_MODEL_ID = "manual/custom-smoke-model";
const BEARER_TOKEN = "aiqsa-local-fixture-token";
const EXPECTED_TEXT = "AIQSA_CUSTOM_OK";
const EXPECTED_USAGE = {
  inputTokens: 7,
  outputTokens: 3,
  reasoningTokens: 0,
  totalTokens: 10
};
const MAX_REQUEST_BYTES = 64 * 1_024;

type CapturedRequest = Readonly<{
  authorization: string | null;
  maxCompletionTokens: unknown;
  method: string | undefined;
  model: unknown;
  stream: unknown;
  url: string | undefined;
}>;

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > MAX_REQUEST_BYTES) {
      throw new Error("custom_openai_fixture_request_too_large");
    }
    chunks.push(buffer);
  }

  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("custom_openai_fixture_request_invalid");
  }
  return value as Record<string, unknown>;
}

function writeStreamingAnswer(response: ServerResponse, responseId: string): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "close",
    "content-type": "text/event-stream; charset=utf-8"
  });
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: "AIQSA_" }, index: 0 }],
    id: responseId,
    model: MANUAL_MODEL_ID,
    object: "chat.completion.chunk"
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: "CUSTOM_OK" }, finish_reason: "stop", index: 0 }],
    id: responseId,
    model: MANUAL_MODEL_ID,
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: EXPECTED_USAGE.outputTokens,
      prompt_tokens: EXPECTED_USAGE.inputTokens,
      total_tokens: EXPECTED_USAGE.totalTokens
    }
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function collect(
  adapter: ProviderAdapter,
  request: ProviderRunRequest
): Promise<Readonly<{
  result: ProviderRunResult;
  textDeltas: string[];
  usageEventCount: number;
}>> {
  const stream = adapter.stream(request);
  const textDeltas: string[] = [];
  let usageEventCount = 0;
  let next = await stream.next();

  while (!next.done) {
    if (next.value.type === "token") {
      textDeltas.push(next.value.data.delta);
    } else if (next.value.type === "usage") {
      usageEventCount += 1;
    }
    next = await stream.next();
  }

  return { result: next.value, textDeltas, usageEventCount };
}

function smokeRequest(provider: string): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: `custom-compatible-smoke-${provider}`,
    content: {
      blocks: [{ text: "Return the deterministic fixture marker.", type: "text" }]
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: false,
      pdf: false,
      reasoning: false,
      streaming: true,
      toolCalling: false,
      vision: false
    },
    modelId: MANUAL_MODEL_ID,
    params: {
      maxOutputTokens: 8,
      stream: true
    },
    prompt: {
      developer: null,
      system: "This request targets a local deterministic smoke fixture."
    },
    provider,
    searchStrategy: "search-disabled"
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function main(): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { connection: "close" });
        response.end();
        return;
      }
      const body = await requestBody(request);
      const authorization = request.headers.authorization ?? null;
      captured.push({
        authorization,
        maxCompletionTokens: body.max_completion_tokens,
        method: request.method,
        model: body.model,
        stream: body.stream,
        url: request.url
      });

      if (authorization !== null && authorization !== `Bearer ${BEARER_TOKEN}`) {
        response.writeHead(401, { connection: "close" });
        response.end();
        return;
      }
      writeStreamingAnswer(
        response,
        authorization ? "fixture-bearer-response" : "fixture-no-auth-response"
      );
    } catch {
      response.writeHead(400, { connection: "close" });
      response.end();
    }
  });

  server.listen(0, LOOPBACK_HOST);
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address === "object", "fixture_address_missing");
    const apiRoot = `http://${LOOPBACK_HOST}:${address.port}/v1`;

    const bearer = await collect(
      createOpenAICompatibleChatAdapter({
        client: createFetchOpenAICompatibleChatClient({
          apiRoot,
          authenticationMode: "bearer",
          bearerToken: BEARER_TOKEN
        })
      }),
      smokeRequest("custom-bearer")
    );
    const noAuth = await collect(
      createOpenAICompatibleChatAdapter({
        client: createFetchOpenAICompatibleChatClient({
          apiRoot,
          authenticationMode: "none",
          bearerToken: null
        })
      }),
      smokeRequest("custom-no-auth")
    );

    for (const outcome of [bearer, noAuth]) {
      assert.equal(outcome.result.finalText, EXPECTED_TEXT);
      assert.deepEqual(outcome.textDeltas, ["AIQSA_", "CUSTOM_OK"]);
      assert.equal(outcome.usageEventCount, 1);
      assert.deepEqual(outcome.result.usage, {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        ...EXPECTED_USAGE
      });
    }
    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map(({ method, model, stream, url }) => ({
      method,
      model,
      stream,
      url
    })), [
      {
        method: "POST",
        model: MANUAL_MODEL_ID,
        stream: true,
        url: "/v1/chat/completions"
      },
      {
        method: "POST",
        model: MANUAL_MODEL_ID,
        stream: true,
        url: "/v1/chat/completions"
      }
    ]);
    assert.equal(captured[0]?.authorization, `Bearer ${BEARER_TOKEN}`);
    assert.equal(captured[1]?.authorization, null);
    assert.equal(captured[0]?.maxCompletionTokens, 8);
    assert.equal(captured[1]?.maxCompletionTokens, 8);

    console.log(JSON.stringify({
      bearerAuthorizationVerified: true,
      manualModelIdVerified: true,
      noAuthAuthorizationOmitted: true,
      requestCount: captured.length,
      status: "passed",
      streamingTextVerified: true,
      usageVerified: true
    }, null, 2));
  } finally {
    await closeServer(server);
  }
}

main().catch(() => {
  console.error("Custom OpenAI-compatible local smoke failed.");
  process.exit(1);
});
