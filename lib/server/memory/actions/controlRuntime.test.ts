import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_ACTION_INTENT_NAME,
  type MemoryActionIntent
} from "../../../contracts/memoryActionIntent";
import {
  MEMORY_CONTROL_PIPELINE_VERSION,
  MEMORY_CONTROL_VERSIONS,
  MEMORY_READ_ONLY_CONTROL_REUSE_VERSION,
  MemoryControlProviderCallError,
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
  memoryUseful: true,
  patternExclusionRequested: false,
  pastChatsUseful: false,
  profileRequested: true,
  queryDecompositions: [],
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
    expect(MEMORY_CONTROL_PIPELINE_VERSION).toBe("memory-control-v17");
    expect(MEMORY_CONTROL_VERSIONS).toMatchObject({
      pipelineVersion: "memory-control-v17",
      policyVersion: "memory-control-policy-v17",
      promptVersion: "memory-control-prompt-v23",
      schemaVersion: "memory-action-intent-v10"
    });
    expect(MEMORY_READ_ONLY_CONTROL_REUSE_VERSION).toBe(7);
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
      version: 7
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

  it.each([
    ["REPLAY_SAFE_TRANSIENT", "memory_action_intent_transient", "FAILED"],
    ["UNKNOWN", "memory_action_intent_outcome_unknown", "OUTCOME_UNKNOWN"],
    ["PERMANENT", "memory_action_intent_unavailable", "FAILED"]
  ] as const)(
    "preserves %s provider failure classification",
    async (classification, reason, state) => {
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
        provider: {
          run: vi.fn(async () => {
            throw new MemoryControlProviderCallError({
              cause: new Error("provider failure"),
              classification,
              usage: null
            });
          })
        }
      });

      await expect(service.decide({
        attemptId: "attempt-1",
        context: {
          capabilities: {
            automaticLearning: true,
            historyRecall: true,
            memoryEnabled: true
          },
          currentUserMessage: "What are my current preferences?"
        },
        signal: new AbortController().signal,
        userId: "user-1"
      })).resolves.toMatchObject({ reason, status: "UNAVAILABLE" });
      expect(settle).toHaveBeenCalledWith(
        "user-1",
        "control-binding",
        expect.objectContaining({ errorCode: reason, state })
      );
    }
  );

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
