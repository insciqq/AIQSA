import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_ACTION_INTENT_NAME,
  type MemoryActionIntent
} from "../../../contracts/memoryActionIntent";
import {
  MEMORY_CONTROL_PIPELINE_VERSION,
  MEMORY_CONTROL_VERSIONS,
  MEMORY_READ_ONLY_CONTROL_REUSE_VERSION,
  createMemoryControlService,
  createMemoryReadOnlyControlReuseProof,
  decodeMemoryReadOnlyControlReuseProof
} from "./controlRuntime";

const profileIntent: MemoryActionIntent = {
  action: "NONE",
  aggregationRequested: false,
  applyResponsePreferences: false,
  category: null,
  categoryHint: null,
  confidenceBand: "HIGH",
  entityMentions: [],
  includePatterns: false,
  memoryUseful: true,
  pastChatsUseful: false,
  profileRequested: true,
  queryText: "current Saved and learned facts about the user",
  reasonCode: "no_memory_request",
  recencyRequested: false,
  retrievalMode: "CURRENT_PROFILE",
  referencedMemoryRef: null,
  replacementStatement: null,
  responsePreference: false,
  sensitiveDomainHint: null,
  sensitivity: "NORMAL",
  statement: null,
  targetQuery: null,
  temporalAsOf: null,
  temporalFrom: null,
  temporalIntent: "CURRENT",
  temporalTo: null,
  thisChatOnly: false
};

describe("Memory control runtime contract", () => {
  it("binds the profile decision to the current control contract versions", () => {
    expect(MEMORY_CONTROL_PIPELINE_VERSION).toBe("memory-control-v14");
    expect(MEMORY_CONTROL_VERSIONS).toMatchObject({
      pipelineVersion: "memory-control-v14",
      policyVersion: "memory-control-policy-v14",
      promptVersion: "memory-control-prompt-v19",
      schemaVersion: "memory-action-intent-v8"
    });
    expect(MEMORY_READ_ONLY_CONTROL_REUSE_VERSION).toBe(6);
  });

  it("round-trips the exact broad-profile decision and rejects a legacy proof version", () => {
    const proof = createMemoryReadOnlyControlReuseProof({
      inputHash: "a".repeat(64),
      result: {
        bindingId: "control-binding",
        intent: profileIntent,
        status: "READY"
      },
      sourceAttemptId: "source-attempt"
    });

    expect(proof).not.toBeNull();
    expect(decodeMemoryReadOnlyControlReuseProof(proof)).toMatchObject({
      intent: { profileRequested: true },
      version: 6
    });
    expect(decodeMemoryReadOnlyControlReuseProof({ ...proof, version: 1 })).toBeNull();
  });

  it("redacts every control-provider text field before provider I/O", async () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    let serializedRequest = "";
    const run = vi.fn(async (_evidence, request) => {
      serializedRequest = JSON.stringify(request);
      throw new Error("stop after boundary inspection");
    });
    const settle = vi.fn(async () => undefined);
    const service = createMemoryControlService({
      execution: {
        admission: {
          bind: vi.fn(async () => ({ id: "control-binding" })),
          start: vi.fn(async () => ({
            bindingId: "control-binding",
            snapshot: {
              logicalRole: "MEMORY_CONTROL",
              providerExecutionSnapshot: {
                connectionId: "connection-1",
                credentialId: "credential-1",
                credentialVersionId: "credential-version-1",
                providerModelId: "model-1"
              },
              requiresStrictStructuredOutput: true
            }
          }))
        },
        lifecycle: {
          settle,
          withAuthorizedResultCommit: vi.fn()
        }
      } as never,
      provider: { run }
    });

    await expect(service.decide({
      attemptId: "attempt-1",
      context: {
        capabilities: {
          automaticLearning: true,
          historyRecall: true,
          memoryEnabled: true
        },
        currentUserMessage: `Remember that I live in Helsinki; token ${token}`,
        memoryRefs: [`safe ref beside ${token}`],
        recentMessages: [{
          role: "user",
          text: `Earlier safe context beside ${token}`
        }]
      },
      signal: new AbortController().signal,
      userId: "user-1"
    })).resolves.toMatchObject({ status: "UNAVAILABLE" });

    expect(run).toHaveBeenCalledOnce();
    expect(serializedRequest).not.toContain(token);
    expect(serializedRequest).toContain("Helsinki");
    expect(serializedRequest).toContain("REDACTED");
    expect(settle).toHaveBeenCalledWith(
      "user-1",
      "control-binding",
      expect.objectContaining({ state: "FAILED" })
    );
  });

  it("redacts recognized secrets in provider output before binding the intent", async () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const settle = vi.fn(async () => undefined);
    const service = createMemoryControlService({
      execution: {
        admission: {
          bind: vi.fn(async () => ({ id: "control-binding" })),
          start: vi.fn(async () => ({
            bindingId: "control-binding",
            snapshot: {
              logicalRole: "MEMORY_CONTROL",
              providerExecutionSnapshot: {
                connectionId: "connection-1",
                credentialId: "credential-1",
                credentialVersionId: "credential-version-1",
                providerModelId: "model-1"
              },
              requiresStrictStructuredOutput: true
            }
          }))
        },
        lifecycle: {
          settle,
          withAuthorizedResultCommit: vi.fn(async (
            _userId: string,
            _input: unknown,
            apply: () => Promise<unknown>
          ) => apply())
        }
      } as never,
      provider: {
        run: vi.fn(async () => ({
          providerResponseId: "provider-response-1",
          toolCalls: [{
            arguments: {
              ...profileIntent,
              action: "SAVE",
              memoryUseful: false,
              profileRequested: false,
              queryText: null,
              reasonCode: "save_request",
              retrievalMode: "TARGETED_CURRENT",
              statement: `I live in Helsinki. Token ${token}`
            },
            id: "call-1",
            name: MEMORY_ACTION_INTENT_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            totalTokens: 15
          }
        }))
      }
    });

    const result = await service.decide({
      attemptId: "attempt-1",
      context: {
        capabilities: {
          automaticLearning: true,
          historyRecall: true,
          memoryEnabled: true
        },
        currentUserMessage: "Remember that I live in Helsinki."
      },
      signal: new AbortController().signal,
      userId: "user-1"
    });

    expect(result).toMatchObject({
      intent: {
        statement: "I live in Helsinki. Token [REDACTED:TOKEN]"
      },
      status: "READY"
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(settle.mock.calls)).not.toContain(token);
  });
});
