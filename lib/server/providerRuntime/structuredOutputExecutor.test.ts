import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import type { ProviderAdmissionRole } from "./admission";
import {
  assertAcceptedStructuredOutputSnapshotExecutable,
  createAcceptedStructuredOutputExecutor,
  createAcceptedStructuredOutputSnapshotExecutor
} from "./structuredOutputExecutor";

const KEY = Buffer.alloc(32, 19);

function role(structuredOutput = true): ProviderAdmissionRole {
  const capabilities = {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: true,
    ...(structuredOutput ? { structuredOutput: true } : {}),
    vision: false
  };
  return {
    authority: {
      connectionId: "connection-1",
      connectionVersion: 2,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      modelVersion: 3,
      providerModelId: "provider-model-1"
    },
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_native",
      capabilities,
      defaultParams: {}
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.openai.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "OpenAI",
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "gpt-structured"
      },
      modelDisplayName: "Structured model",
      providerFamily: "openai",
      providerModelId: "provider-model-1",
      version: 1
    }
  };
}

const request = {
  name: "router_selection",
  schema: {
    additionalProperties: false,
    properties: { serverIds: { items: { type: "string" }, type: "array" } },
    required: ["serverIds"],
    type: "object"
  },
  systemPrompt: "Return only the schema result.",
  userPrompt: "Choose servers."
} as const;

describe("accepted structured-output executor", () => {
  it("attests exact credential decryptability without provider network work", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key: KEY,
      secret: "runtime-secret",
      valueId: "credential-version-1"
    });
    const queryRaw = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const client = {
      $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
        consume({ $queryRaw: queryRaw }))
    } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>();

    await expect(assertAcceptedStructuredOutputSnapshotExecutable(
      client,
      role().snapshot,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    )).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(assertAcceptedStructuredOutputSnapshotExecutable(
      client,
      role().snapshot,
      { createFetch: () => fetchFn, encryptionKey: () => Buffer.alloc(32, 20) }
    )).rejects.toMatchObject({
      message: "secret_encryption_invalid_envelope",
      name: "SecretEnvelopeError"
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("locks and decrypts the admitted credential at each strict-schema request", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key: KEY,
      secret: "runtime-secret",
      valueId: "credential-version-1"
    });
    let revoked = false;
    const queryRaw = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: revoked ? new Date("2026-08-16T00:00:00.000Z") : null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const client = {
      $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
        consume({ $queryRaw: queryRaw }))
    } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-structured",
        stream: false,
        text: { format: { name: "router_selection", strict: true, type: "json_schema" } }
      });
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ serverIds: ["mcp-a"] }),
        status: "completed"
      }), { status: 200 });
    });
    const execute = createAcceptedStructuredOutputExecutor(client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });

    await expect(execute(role(), request)).resolves.toEqual({ serverIds: ["mcp-a"] });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();

    const executeSnapshot = createAcceptedStructuredOutputSnapshotExecutor(client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });
    await expect(executeSnapshot(role().snapshot, request)).resolves.toEqual({
      serverIds: ["mcp-a"]
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    revoked = true;
    await expect(execute(role(), request)).rejects.toThrow("credential_revoked");
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails before credential or network work without verified capability", async () => {
    const transaction = vi.fn();
    const fetchFn = vi.fn<typeof fetch>();
    const execute = createAcceptedStructuredOutputExecutor(
      { $transaction: transaction } as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    );

    await expect(execute(role(false), request)).rejects.toThrow(
      "structured_output_not_supported"
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
