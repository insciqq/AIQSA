import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRuntimeBinding } from "../../lib/server/providers/runtimeFactory";
import { buildAnthropicMessagesRequest } from "../../lib/server/providers/anthropicMessages";
import { decodeKnowledgeCitationViewer } from "../../lib/contracts/knowledgeCitations";
import { knowledgeCitationHandlesFromText } from "../../lib/contracts/knowledge";
import { groundKnowledgeAnswer } from "../../lib/server/knowledge/grounding";
import {
  KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS,
  KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX,
  KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS,
  ProviderAnswerCallFailure,
  ProviderAnswerEvalError,
  assertProviderAnswerReviewArtifactChain,
  buildProviderAnswerEvalRequest,
  createPersistedProviderAnswerReviewArtifacts,
  parseProviderAnswerEvalCli,
  providerAnswerEvalCases,
  providerAnswerEvalExecutionSnapshot,
  providerAnswerEvalProfiles,
  runProviderAnswerEval,
  validateProviderAnswerReviewDirectory,
  writeProviderAnswerReviewArtifacts,
  type ProviderAnswerCallInput,
  type ProviderAnswerOutputFreeze,
  type ProviderAnswerReviewMapping,
  type ProviderAnswerReviewPacket
} from "./providerAnswerEval";

const temporaryPaths: string[] = [];

async function reviewDirectory(): Promise<string> {
  const path = await mkdtemp(join("/tmp", KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX));
  await chmod(path, 0o700);
  temporaryPaths.push(path);
  return path;
}

async function jsonFile<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function answerFor(input: ProviderAnswerCallInput): string {
  void input;
  return "Supported answer from the selected source. [K1]";
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })));
});

describe("provider answer evaluation contracts", () => {
  it("pins exactly eight bilingual blinded-review cases without exposing authored answers", () => {
    const cases = providerAnswerEvalCases();

    expect(cases).toHaveLength(KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT);
    expect(cases.filter(({ language }) => language === "en")).toHaveLength(4);
    expect(cases.filter(({ language }) => language === "ru")).toHaveLength(4);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(8);
    expect(cases.every((candidate) =>
      !Object.prototype.hasOwnProperty.call(candidate, "answer"))).toBe(true);
    expect(cases.map(({ id }) => id)).toEqual([
      "blind-release-en-direct-list-polar-fieldwork-records",
      "blind-release-ru-direct-list-textile-production-records",
      "blind-release-en-no-answer-museum-conservation-missing-records",
      "blind-release-ru-no-answer-wildfire-response-missing-records",
      "blind-release-en-coverage-conflict-hatchery-cohorts-coverage",
      "blind-release-ru-coverage-conflict-telecom-outages-coverage",
      "blind-release-en-dated-table-pharma-packaging-observations",
      "blind-release-ru-version-reference-urban-transit-actual-reference"
    ]);
    expect(cases.map(({ query }) => query)).toEqual([
      "Which two facts are recorded in the polar research field log?",
      "Какие два факта указаны в производственной карте текстильной фабрики?",
      "What was the frame maker's childhood address?",
      "Какой марки были сапоги первого патруля?",
      "Do all selected sources agree that the screen-cleaning round is complete, and do they confirm that the vaccination-tray inspection passed?",
      "Подтверждают ли выбранные источники, что аудит пломб шкафа завершён и что проверка резервного маршрута прошла?",
      "Compare the two dated carton rejection rate readings for pharmaceutical packaging batch record.",
      "Каковы фактическое значение и референсный интервал зазора дверного порога в редакции 2048?"
    ]);
  });

  it("pins the native catalog profiles and bounded production request contract", () => {
    const profiles = providerAnswerEvalProfiles();
    const cases = providerAnswerEvalCases();

    expect(profiles.map(({ adapterKind, modelId, provider }) => ({
      adapterKind,
      modelId,
      provider
    }))).toEqual([
      { adapterKind: "openai_responses_native", modelId: "gpt-5.5", provider: "openai" },
      { adapterKind: "anthropic_messages", modelId: "claude-sonnet-5", provider: "anthropic" },
      { adapterKind: "gemini_interactions_native", modelId: "gemini-3.6-flash", provider: "gemini" }
    ]);
    expect(profiles).toHaveLength(3);
    expect(profiles.length * cases.length).toBe(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS);

    for (const profile of profiles) {
      const request = buildProviderAnswerEvalRequest(profile, cases[0]!);
      const fetchFn = vi.fn<typeof fetch>();
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret: "synthetic-eval-key",
        snapshot: providerAnswerEvalExecutionSnapshot(profile)
      });
      expect(request.toolMode).toBe("none");
      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.searchPlan.options).toEqual([]);
      expect(request.forceNonStreaming).toBe(true);
      expect(request.prompt.system).toEqual(expect.any(String));
      expect(request.context?.messages.map(({ id }) => id)).toEqual([
        "knowledge-evidence:v2",
        "current-user-message"
      ]);
      expect(request.params.maxOutputTokens ?? request.params.maxTokens)
        .toBe(KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS);
      expect(runtime.responseTimeoutMs).toBe(KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS);
      expect(() => runtime.adapter.buildRequestPreview(request)).not.toThrow();
      expect(fetchFn).not.toHaveBeenCalled();

      for (const caseDefinition of cases) {
        const providerRequest = buildProviderAnswerEvalRequest(profile, caseDefinition);
        const providerRequestText = JSON.stringify(providerRequest);
        expect(providerRequest.chatId).toMatch(
          /^knowledge-provider-answer-eval-[a-f0-9]{24}$/u
        );
        expect(providerRequest.knowledgePlan.baseIds).toEqual([
          expect.stringMatching(/^review-base-[a-f0-9]{24}$/u)
        ]);
        for (const fixtureId of cases.map(({ id }) => id)) {
          expect(providerRequestText).not.toContain(fixtureId);
        }
        const privateIdentityValues = [
          caseDefinition.evidence.runId,
          caseDefinition.evidence.sessionId,
          ...caseDefinition.evidence.items.flatMap((item) => [
            item.id,
            item.documentId,
            item.documentVersionId,
            item.fileName,
            item.knowledgeBaseId,
            item.passageId,
            item.sectionId,
            item.sourceArtifactId,
            item.sourceId,
            item.sourceVersionId
          ])
        ].filter((value): value is string => typeof value === "string" && value.length > 0);
        for (const privateIdentity of privateIdentityValues) {
          expect(providerRequestText).not.toContain(privateIdentity);
        }
        for (const authoredToken of [
          "blind-release-",
          "direct-list",
          "no-answer",
          "coverage-conflict",
          "dated-table",
          "version-reference",
          "missing-records",
          "actual-reference"
        ]) {
          expect(providerRequestText).not.toContain(authoredToken);
        }
        expect(providerRequestText).not.toMatch(
          /blind-release-[a-z-]+\.md/iu
        );
      }
    }

    const anthropic = profiles.find(({ provider }) => provider === "anthropic");
    expect(anthropic).toBeDefined();
    const anthropicBody = buildAnthropicMessagesRequest(
      buildProviderAnswerEvalRequest(anthropic!, cases[0]!)
    );
    expect(anthropicBody).not.toHaveProperty("temperature");
    expect(anthropicBody).toMatchObject({
      output_config: { effort: "low" },
      thinking: { type: "adaptive" }
    });
  });

  it("requires explicit paid execution and one exact review directory argument", () => {
    const path = "/tmp/aiqsa-knowledge-provider-review-ABC123";

    expect(parseProviderAnswerEvalCli([
      "--execute-paid", "--review-dir", path
    ])).toEqual({ executePaid: true, provider: null, reviewDirectory: path });
    expect(parseProviderAnswerEvalCli([
      "--execute-paid", "--provider", "anthropic", "--review-dir", path
    ])).toEqual({ executePaid: true, provider: "anthropic", reviewDirectory: path });
    expect(() => parseProviderAnswerEvalCli(["--review-dir", path])).toThrowError(
      expect.objectContaining({ code: "knowledge_provider_answer_eval_execution_not_authorized" })
    );
    expect(() => parseProviderAnswerEvalCli(["--execute-paid", "--unknown"]))
      .toThrowError(expect.objectContaining({
        code: "knowledge_provider_answer_eval_arguments_invalid"
      }));
    expect(() => parseProviderAnswerEvalCli([
      "--execute-paid", "--execute-paid", "--review-dir", path
    ])).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_eval_arguments_invalid"
    }));
    expect(() => parseProviderAnswerEvalCli([
      "--execute-paid", "--provider", "unknown", "--review-dir", path
    ])).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_eval_arguments_invalid"
    }));
  });
});

describe("private review directory", () => {
  it("accepts only an owned, empty, non-symlink direct child of /tmp with mode 0700", async () => {
    const valid = await reviewDirectory();
    await expect(validateProviderAnswerReviewDirectory(valid)).resolves.toBe(valid);

    await chmod(valid, 0o755);
    await expect(validateProviderAnswerReviewDirectory(valid)).rejects.toMatchObject({
      code: "knowledge_provider_answer_eval_review_directory_permissions_invalid"
    });
    await chmod(valid, 0o700);
    await writeFile(join(valid, "occupied"), "synthetic");
    await expect(validateProviderAnswerReviewDirectory(valid)).rejects.toMatchObject({
      code: "knowledge_provider_answer_eval_review_directory_not_empty"
    });
  });

  it("rejects lexical escapes, paths outside /tmp, and symlink targets", async () => {
    await expect(validateProviderAnswerReviewDirectory(
      "/var/tmp/aiqsa-knowledge-provider-review-ABC123"
    )).rejects.toBeInstanceOf(ProviderAnswerEvalError);
    await expect(validateProviderAnswerReviewDirectory(
      "/tmp/aiqsa-knowledge-provider-review-ABC123/../aiqsa-knowledge-provider-review-DEF456"
    )).rejects.toBeInstanceOf(ProviderAnswerEvalError);

    const target = await reviewDirectory();
    const link = join(
      "/tmp",
      `${KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX}link-${randomUUID().slice(0, 8)}`
    );
    await symlink(target, link);
    temporaryPaths.push(link);
    await expect(validateProviderAnswerReviewDirectory(link)).rejects.toMatchObject({
      code: "knowledge_provider_answer_eval_review_directory_invalid"
    });
  });
});

describe("hermetic provider answer execution", () => {
  it("runs 24 calls sequentially and writes separated 0600 blinded artifacts", async () => {
    const directory = await reviewDirectory();
    let activeCalls = 0;
    let maximumConcurrency = 0;
    let callCount = 0;
    let clock = 1_000;
    let identifier = 0;
    const executor = vi.fn(async (input: ProviderAnswerCallInput) => {
      activeCalls += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeCalls);
      callCount += 1;
      expect(Object.keys(input).sort()).toEqual([
        "profile", "request", "signal", "timeoutMs"
      ]);
      expect(input).not.toHaveProperty("caseDefinition");
      expect(input).not.toHaveProperty("expectedBehavior");
      expect(input).not.toHaveProperty("reviewDimensions");
      expect(input.timeoutMs).toBe(KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS);
      expect(input.request.searchPlan.options).toEqual([]);
      expect(input.request.toolMode).toBe("none");
      await Promise.resolve();
      activeCalls -= 1;
      return {
        answer: answerFor(input),
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 15
        }
      };
    });

    const report = await runProviderAnswerEval({
      executePaid: true,
      nowMs: () => {
        clock += 1;
        return clock;
      },
      prepareExecutor: () => executor,
      randomId: () => `blind-review-${++identifier}`,
      randomIndex: () => 0,
      reviewDirectory: directory
    });

    expect(report.status).toBe("review_required");
    expect(report.constraints.plannedCalls).toBe(24);
    expect(report.corpus).toMatchObject({
      caseCount: 8,
      languages: { en: 4, ru: 4 },
      reviewSplit: "blinded_review",
      slice: "bounded_bilingual_release_review"
    });
    expect(report.execution).toEqual({
      attemptedCalls: 24,
      completedCalls: 24,
      failedCalls: 0,
      paidExecutionAuthorized: true,
      skippedCalls: 0
    });
    expect(report.review).toMatchObject({
      artifactsFrozenBeforeReview: true,
      citationViewerProvenance: "synthetic_projection",
      citationViewerReleaseEligible: false,
      independence: "operator_delegated_agent_review_not_independent",
      mappingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outputFreezeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packetItemCount: 24,
      packetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      releaseEligibility: {
        eligible: false,
        reasonCodes: [
          "independent_human_review_not_completed",
          "synthetic_citation_viewer_projection"
        ]
      },
      reviewComplete: false,
      semanticReleaseProof: false
    });
    expect(report.providers.map(({ attemptedCalls, completedCalls, skippedCalls, usage }) => ({
      attemptedCalls,
      completedCalls,
      skippedCalls,
      usage
    }))).toEqual(Array.from({ length: 3 }, () => ({
      attemptedCalls: 8,
      completedCalls: 8,
      skippedCalls: 0,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 0,
        totalTokens: 120
      }
    })));
    expect(callCount).toBe(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS);
    expect(executor).toHaveBeenCalledTimes(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS);
    expect(maximumConcurrency).toBe(1);
    const reportText = JSON.stringify(report);
    expect(reportText).not.toContain('"answer"');
    expect(reportText).not.toContain('"evidence"');
    expect(reportText).not.toContain('"query"');
    expect(reportText).not.toContain("After 00:00, queue suspension");
    expect(reportText).not.toContain("OPENAI_API_KEY");

    const paths = (await readdir(directory)).sort();
    expect(paths).toEqual([
      KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
      KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
      KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE
    ]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const name of paths) {
      expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    }

    const packet = await jsonFile<ProviderAnswerReviewPacket>(
      join(directory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE)
    );
    const mapping = await jsonFile<ProviderAnswerReviewMapping>(
      join(directory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE)
    );
    const freeze = await jsonFile<ProviderAnswerOutputFreeze>(
      join(directory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE)
    );
    const packetText = JSON.stringify(packet);
    const mappingText = JSON.stringify(mapping);
    const freezeText = JSON.stringify(freeze);
    const packetItems = packet.items;
    const mappingEntries = mapping.entries;
    expect(packetItems).toHaveLength(24);
    expect(mappingEntries).toHaveLength(24);
    expect(packetItems.every((item) =>
      !("provider" in item) && !("modelId" in item) && !("caseId" in item))).toBe(true);
    expect(packetItems.map(({ reviewId }) => reviewId)).not.toEqual(
      mappingEntries.map(({ reviewId }) => reviewId)
    );
    expect(packetText).not.toContain("gpt-5.5");
    expect(packetText).not.toContain("claude-sonnet-5");
    expect(packetText).not.toContain("gemini-3.6-flash");
    for (const fixtureId of providerAnswerEvalCases().map(({ id }) => id)) {
      expect(packetText).not.toContain(fixtureId);
    }
    for (const authoredToken of [
      "blind-release-", "direct-list", "no-answer", "coverage-conflict",
      "dated-table", "version-reference", "missing-records", "actual-reference"
    ]) {
      expect(packetText).not.toContain(authoredToken);
    }
    expect(mappingText).not.toContain('"answer"');
    expect(mappingText).not.toContain('"evidence"');
    expect(mappingText).not.toContain('"query"');
    expect(freezeText).not.toContain('"answer"');
    expect(freezeText).not.toContain('"query"');
    expect(freezeText).not.toContain('"provider"');
    expect(freeze).toMatchObject({
      mappingSha256: mapping.mappingSha256,
      outputCount: 24,
      packetSha256: packet.packetSha256
    });
    expect(report.review).toMatchObject({
      mappingSha256: mapping.mappingSha256,
      outputFreezeSha256: freeze.freezeSha256,
      packetSha256: packet.packetSha256
    });
    expect(() => assertProviderAnswerReviewArtifactChain({ freeze, mapping, packet }))
      .not.toThrow();
    for (const item of packetItems) {
      expect(item.reviewDimensions).toEqual([
        "correctness",
        "completeness",
        "verifiability",
        "citation_usability",
        "no_answer_clarity",
        "temporal_version_handling",
        "technical_leakage",
        "supported_claim_preservation"
      ]);
      expect(item.citationViewerArtifacts).toHaveLength(item.sourceLocalEvidence.length);
      const viewerHandles = new Set(item.citationViewerArtifacts.map((artifact) => {
        expect(artifact).toMatchObject({
          provenance: "synthetic_projection",
          releaseEvidenceEligible: false
        });
        expect(decodeKnowledgeCitationViewer(artifact.viewer)).not.toBeNull();
        return artifact.viewer.handle;
      }));
      expect(knowledgeCitationHandlesFromText(item.answer).every((handle) =>
        viewerHandles.has(handle))).toBe(true);
    }
  });

  it("does not prepare an executor without explicit paid authorization", async () => {
    const prepareExecutor = vi.fn();
    await expect(runProviderAnswerEval({
      executePaid: false,
      prepareExecutor,
      reviewDirectory: "/tmp/aiqsa-knowledge-provider-review-ABC123"
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_eval_execution_not_authorized"
    });
    expect(prepareExecutor).not.toHaveBeenCalled();
  });

  it("freezes grounded final text instead of the raw provider draft", async () => {
    const directory = await reviewDirectory();
    const rawDraftCitation = "(K1)";
    let reviewIdentifier = 0;
    await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => async (input) => ({
        answer: `Supported answer from the selected source. ${rawDraftCitation}`,
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
      }),
      randomId: () => `blind-review-grounded-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: directory,
      selectedProvider: "anthropic"
    });

    const packetText = await readFile(
      join(directory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE),
      "utf8"
    );
    expect(packetText).not.toContain(rawDraftCitation);
    expect(packetText).toContain("[K1]");
  });

  it("accepts separately captured persisted-route viewer artifacts without upgrading release proof", async () => {
    const sourceDirectory = await reviewDirectory();
    let reviewIdentifier = 0;
    await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => async (input) => ({
        answer: answerFor(input),
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
      }),
      randomId: () => `blind-review-persisted-source-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: sourceDirectory,
      selectedProvider: "anthropic"
    });
    const generatedPacket = await jsonFile<ProviderAnswerReviewPacket>(
      join(sourceDirectory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE)
    );
    const generatedMapping = await jsonFile<ProviderAnswerReviewMapping>(
      join(sourceDirectory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE)
    );
    const caseDefinitions = providerAnswerEvalCases();
    const profile = providerAnswerEvalProfiles().find(({ provider }) => provider === "anthropic")!;
    const artifacts = createPersistedProviderAnswerReviewArtifacts({
      completed: caseDefinitions.map((caseDefinition, index) => {
        const mappingEntry = generatedMapping.entries.find((entry) =>
          entry.status === "complete" && entry.caseId === caseDefinition.id);
        expect(mappingEntry?.status).toBe("complete");
        if (mappingEntry?.status !== "complete") {
          throw new Error("expected complete provider-answer mapping entry");
        }
        const generatedItem = generatedPacket.items.find((item) =>
          item.reviewId === mappingEntry.reviewId);
        expect(generatedItem).toBeDefined();
        const answer = caseDefinition.evidence.items
          .map((item) => `${item.excerpt} [${item.handle}]`)
          .join(" ");
        return {
          answer,
          automatedGrounding: mappingEntry.automatedGrounding,
          caseDefinition,
          citationViewerArtifacts: generatedItem!.citationViewerArtifacts.map((artifact) => ({
            provenance: "persisted_route" as const,
            releaseEvidenceEligible: true as const,
            viewer: artifact.viewer
          })),
          grounding: groundKnowledgeAnswer({ answer, evidence: caseDefinition.evidence }),
          latencyMs: 1,
          profile,
          reviewId: `persisted-route-review-${index + 1}`,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }),
      randomIndex: () => 0
    });

    expect(artifacts.packet.items).toHaveLength(8);
    expect(artifacts.packet.items.every((item) => item.citationViewerArtifacts.every((artifact) =>
      artifact.provenance === "persisted_route" &&
      artifact.releaseEvidenceEligible === true))).toBe(true);
    for (const entry of artifacts.mapping.entries) {
      if (entry.status !== "complete") {
        continue;
      }
      const sourceEntry = generatedMapping.entries.find((source) =>
        source.status === "complete" && source.caseId === entry.caseId);
      expect(entry.automatedGrounding).toEqual(
        sourceEntry?.status === "complete" ? sourceEntry.automatedGrounding : undefined
      );
    }
    expect(() => assertProviderAnswerReviewArtifactChain(artifacts)).not.toThrow();
  });

  it("rejects a tampered packet, mapping, or freeze before writing artifacts", async () => {
    expect(() => assertProviderAnswerReviewArtifactChain({})).toThrowError(
      expect.objectContaining({
        code: "knowledge_provider_answer_eval_review_artifact_invalid"
      })
    );
    const sourceDirectory = await reviewDirectory();
    let reviewIdentifier = 0;
    await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => async (input) => ({
        answer: answerFor(input),
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
      }),
      randomId: () => `blind-review-chain-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: sourceDirectory,
      selectedProvider: "anthropic"
    });
    const packet = await jsonFile<ProviderAnswerReviewPacket>(
      join(sourceDirectory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE)
    );
    const mapping = await jsonFile<ProviderAnswerReviewMapping>(
      join(sourceDirectory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE)
    );
    const freeze = await jsonFile<ProviderAnswerOutputFreeze>(
      join(sourceDirectory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE)
    );

    const tamperedPacket = structuredClone(packet) as unknown as ProviderAnswerReviewPacket;
    (tamperedPacket.items[0] as { answer: string }).answer += " altered";
    expect(() => assertProviderAnswerReviewArtifactChain({
      freeze,
      mapping,
      packet: tamperedPacket
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_eval_review_artifact_invalid"
    }));

    const tamperedMapping = structuredClone(mapping) as unknown as ProviderAnswerReviewMapping;
    (tamperedMapping.entries.find((entry) => entry.status === "complete") as {
      outputSha256: string;
    }).outputSha256 = "0".repeat(64);
    expect(() => assertProviderAnswerReviewArtifactChain({
      freeze,
      mapping: tamperedMapping,
      packet
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_eval_review_artifact_invalid"
    }));

    const tamperedFreeze = structuredClone(freeze) as unknown as ProviderAnswerOutputFreeze;
    (tamperedFreeze as { outputCount: number }).outputCount += 1;
    expect(() => assertProviderAnswerReviewArtifactChain({
      freeze: tamperedFreeze,
      mapping,
      packet
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_eval_review_artifact_invalid"
    }));

    const targetDirectory = await reviewDirectory();
    await expect(writeProviderAnswerReviewArtifacts({
      freeze,
      mapping,
      packet: tamperedPacket,
      reviewDirectory: targetDirectory
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_eval_review_artifact_invalid"
    });
    expect(await readdir(targetDirectory)).toEqual([]);
  });

  it("continues with later providers without persisting raw error content", async () => {
    const directory = await reviewDirectory();
    let calls = 0;
    let reviewIdentifier = 0;
    const attemptedProviders: string[] = [];
    const secretMarker = "SYNTHETIC_SECRET_MUST_NOT_APPEAR";
    const report = await runProviderAnswerEval({
      executePaid: true,
      nowMs: () => calls,
      prepareExecutor: () => async (input) => {
        calls += 1;
        attemptedProviders.push(input.profile.provider);
        if (calls === 2) throw new Error(secretMarker);
        return {
          answer: answerFor(input),
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      },
      randomId: () => `blind-review-success-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: directory
    });

    expect(report.status).toBe("failed");
    expect(report.execution).toEqual({
      attemptedCalls: 18,
      completedCalls: 17,
      failedCalls: 1,
      paidExecutionAuthorized: true,
      skippedCalls: 6
    });
    expect(attemptedProviders).toEqual([
      "openai",
      "openai",
      ...Array.from({ length: 8 }, () => "anthropic"),
      ...Array.from({ length: 8 }, () => "gemini")
    ]);
    const packetText = await readFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE), "utf8");
    const mappingText = await readFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE), "utf8");
    expect(JSON.stringify(report)).not.toContain(secretMarker);
    expect(packetText).not.toContain(secretMarker);
    expect(mappingText).not.toContain(secretMarker);
    expect(mappingText).toContain('"failureCode": "provider_call_failed"');
    expect(mappingText.match(/"status": "skipped_after_provider_failure"/gu))
      .toHaveLength(6);
  });

  it("records only a stable HTTP category and status for provider failures", async () => {
    const directory = await reviewDirectory();
    let reviewIdentifier = 0;
    const report = await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => async (input) => {
        if (input.profile.provider === "openai") {
          throw new ProviderAnswerCallFailure("provider_http_error", 401);
        }
        return {
          answer: answerFor(input),
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      },
      randomId: () => `blind-review-http-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: directory
    });

    expect(report.execution).toEqual({
      attemptedCalls: 17,
      completedCalls: 16,
      failedCalls: 1,
      paidExecutionAuthorized: true,
      skippedCalls: 7
    });
    const mapping = await jsonFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE));
    const failedEntry = (mapping.entries as Record<string, unknown>[])
      .find(({ status }) => status === "failed");
    expect(failedEntry).toMatchObject({
      failureCode: "provider_http_error",
      httpStatus: 401,
      provider: "openai",
      status: "failed"
    });
    expect(report.providers[0]?.failureDiagnostics).toEqual({
      byCode: { provider_http_error: 1 },
      byHttpStatus: { "401": 1 }
    });
    expect(JSON.stringify(report)).not.toContain("Unauthorized");
  });

  it("supports a fresh bounded single-provider review slice", async () => {
    const directory = await reviewDirectory();
    let reviewIdentifier = 0;
    const executor = vi.fn(async (input: ProviderAnswerCallInput) => ({
      answer: answerFor(input),
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
    }));

    const report = await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => executor,
      randomId: () => `blind-review-slice-${++reviewIdentifier}`,
      randomIndex: () => 0,
      reviewDirectory: directory,
      selectedProvider: "anthropic"
    });

    expect(report.status).toBe("review_required");
    expect(report.constraints).toMatchObject({ maxCalls: 24, plannedCalls: 8 });
    expect(report.execution).toEqual({
      attemptedCalls: 8,
      completedCalls: 8,
      failedCalls: 0,
      paidExecutionAuthorized: true,
      skippedCalls: 0
    });
    expect(report.providers.map(({ provider }) => provider)).toEqual(["anthropic"]);
    expect(executor).toHaveBeenCalledTimes(8);
  });
});
