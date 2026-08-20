import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/prisma";
import { createMemoryStorageAdapter } from "../support/storage";
import {
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  assertProviderAnswerReviewArtifactChain,
  providerAnswerEvalCases,
  runProviderAnswerEval,
  writeProviderAnswerReviewArtifacts
} from "./providerAnswerEval";
import {
  KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE,
  assertProviderAnswerPersistedRouteProof,
  assertProviderAnswerPersistedRouteReceipt,
  captureProviderAnswerPersistedRoute,
  parseProviderAnswerPersistedRouteCli,
  readProviderAnswerArtifactDirectory,
  readProviderAnswerPersistedRouteProof,
  validatedProviderAnswerPersistedRouteBinding,
  validatedProviderAnswerPersistedRouteReceiptSha256,
  writeProviderAnswerPersistedRouteCapture
} from "./providerAnswerPersistedRoute";

const directories: string[] = [];

async function privateReviewDirectory(): Promise<string> {
  const directory = await mkdtemp("/tmp/aiqsa-knowledge-provider-review-");
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

async function privatePromotionDirectory(): Promise<string> {
  const directory = await mkdtemp("/tmp/aiqsa-knowledge-provider-persisted-route-");
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function answerByQuery(): ReadonlyMap<string, string> {
  return new Map(providerAnswerEvalCases().map((caseDefinition) => {
    if (caseDefinition.expectedBehavior === "honest_no_answer") {
      return [
        caseDefinition.query,
        caseDefinition.language === "ru"
          ? "Запрошенные сведения не указаны в выбранных источниках."
          : "The requested detail is not stated in the selected sources."
      ];
    }
    return [
      caseDefinition.query,
      caseDefinition.evidence.items.map((item) =>
        `${item.excerpt ?? ""} [${item.handle}]`).join("\n")
    ];
  }));
}

describe("provider-answer persisted citation-viewer route", () => {
  afterAll(async () => {
    for (const directory of directories) {
      await rm(directory, { force: true, recursive: true });
    }
    await prisma.$disconnect();
  });

  it("rejects ambiguous CLI selections before any stateful work", () => {
    expect(() => parseProviderAnswerPersistedRouteCli([])).toThrowError(
      expect.objectContaining({
        code: "knowledge_provider_answer_persisted_route_argument_invalid"
      })
    );
    expect(() => parseProviderAnswerPersistedRouteCli([
      "--provider", "anthropic",
      "--input-review-dir", "/tmp/aiqsa-knowledge-provider-review-ABC123",
      "--output-review-dir", "/tmp/aiqsa-knowledge-provider-review-ABC123",
      "--promotion-dir", "/tmp/aiqsa-knowledge-provider-persisted-route-DEF456"
    ])).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_persisted_route_argument_invalid"
    }));
  });

  it("captures eight complete outputs through persisted Evidence v2 and the production viewer", async () => {
    const inputDirectory = await privateReviewDirectory();
    const outputDirectory = await privateReviewDirectory();
    const promotionDirectory = await privatePromotionDirectory();
    const forgedOutputDirectory = await privateReviewDirectory();
    const forgedPromotionDirectory = await privatePromotionDirectory();
    const answers = answerByQuery();
    const answerQueue = [...answers.values()];
    let answerIndex = 0;
    let reviewId = 0;
    await runProviderAnswerEval({
      executePaid: true,
      prepareExecutor: () => async () => ({
        answer: answerQueue[answerIndex++] ??
          "The requested detail is not stated in the selected sources.",
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
      }),
      randomId: () => `persisted-route-stateful-review-${++reviewId}`,
      randomIndex: (maximum) => maximum - 1,
      reviewDirectory: inputDirectory,
      selectedProvider: "anthropic"
    });
    const artifacts = await readProviderAnswerArtifactDirectory(inputDirectory);
    const storage = createMemoryStorageAdapter();

    await expect(captureProviderAnswerPersistedRoute({
      artifacts,
      client: prisma,
      provider: "openai",
      storage
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_persisted_route_incomplete_provider"
    });

    const capture = await captureProviderAnswerPersistedRoute({
      artifacts,
      client: prisma,
      provider: "anthropic",
      storage
    });
    expect(capture.report).toMatchObject({
      aggregateOnly: true,
      caseCount: 8,
      citationViewerPersistedRouteGatePassed: true,
      fullProductionReleaseEligible: false,
      privateContentIncluded: false,
      provider: "anthropic"
    });
    expect(capture.receipt.entries).toHaveLength(8);
    expect(capture.inputArtifacts.mapping.entries).toHaveLength(8);
    expect(capture.inputArtifacts.mapping.entries.every((entry) =>
      entry.provider === "anthropic" && entry.status === "complete"
    )).toBe(true);
    expect(capture.receipt.input).toMatchObject({
      mappingSha256: capture.inputArtifacts.mapping.mappingSha256,
      outputFreezeSha256: capture.inputArtifacts.freeze.freezeSha256,
      packetSha256: capture.inputArtifacts.packet.packetSha256,
      provider: "anthropic"
    });
    const originalOutputMappingSha256 = capture.receipt.output.mappingSha256;
    expect(() => {
      const output = capture.promotion.receipt.output as {
        mappingSha256: string;
      };
      output.mappingSha256 = "0".repeat(64);
    }).toThrow();
    expect(capture.receipt.output.mappingSha256).toBe(originalOutputMappingSha256);
    expect(validatedProviderAnswerPersistedRouteBinding(capture.promotion)).toMatchObject({
      mappingSha256: originalOutputMappingSha256,
      outputFreezeSha256: capture.receipt.output.outputFreezeSha256,
      packetSha256: capture.receipt.output.packetSha256,
      receiptSha256: capture.receipt.executionReceiptSha256
    });
    expect(capture.receipt.entries.every((entry) =>
      entry.providerSourceLocalSha256 === entry.persistedSourceLocalSha256 &&
      entry.providerViewerSetSha256 === entry.persistedViewerSetSha256 &&
      entry.providerEvidenceReceiptSha256 !== entry.persistedEvidenceReceiptSha256
    )).toBe(true);
    expect(capture.artifacts.packet.items).toHaveLength(8);
    expect(capture.artifacts.packet.items.every((item) =>
      item.citationViewerArtifacts.every((artifact) =>
        artifact.provenance === "persisted_route" && artifact.releaseEvidenceEligible)
    )).toBe(true);
    expect(() => assertProviderAnswerReviewArtifactChain(capture.artifacts)).not.toThrow();
    expect(() => assertProviderAnswerPersistedRouteReceipt(capture.receipt)).not.toThrow();
    const tampered = structuredClone(capture.receipt) as unknown as {
      entries: Array<{ persistedViewerSetSha256: string }>;
    };
    tampered.entries[0]!.persistedViewerSetSha256 = "0".repeat(64);
    expect(() => assertProviderAnswerPersistedRouteReceipt(tampered)).toThrowError(
      expect.objectContaining({
        code: "knowledge_provider_answer_persisted_route_receipt_invalid"
      })
    );

    const forgedCodeDigestBase = {
      ...capture.receipt,
      codeDigests: {
        ...capture.receipt.codeDigests,
        resolverSha256: "0".repeat(64)
      }
    };
    const {
      executionReceiptSha256: _forgedCodeDigestHash,
      ...forgedCodeDigestBody
    } = forgedCodeDigestBase;
    const forgedCodeDigestReceipt = {
      ...forgedCodeDigestBody,
      executionReceiptSha256: canonicalSha256(forgedCodeDigestBody)
    };
    expect(() => assertProviderAnswerPersistedRouteReceipt(
      forgedCodeDigestReceipt
    )).not.toThrow();
    await expect(assertProviderAnswerPersistedRouteProof({
      inputArtifacts: artifacts,
      outputArtifacts: capture.artifacts,
      receipt: forgedCodeDigestReceipt
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    });

    const crossSwapBase = {
      ...capture.receipt,
      output: {
        mappingSha256: artifacts.mapping.mappingSha256,
        outputFreezeSha256: artifacts.freeze.freezeSha256,
        packetSha256: artifacts.packet.packetSha256
      }
    };
    const { executionReceiptSha256: _crossSwapHash, ...crossSwapBody } = crossSwapBase;
    const crossSwapReceipt = {
      ...crossSwapBody,
      executionReceiptSha256: canonicalSha256(crossSwapBody)
    };
    expect(() => assertProviderAnswerPersistedRouteReceipt(crossSwapReceipt)).not.toThrow();
    await expect(assertProviderAnswerPersistedRouteProof({
      inputArtifacts: artifacts,
      outputArtifacts: artifacts,
      receipt: crossSwapReceipt
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    });

    await expect(writeProviderAnswerPersistedRouteCapture({
      capture: { ...capture },
      outputReviewDirectory: outputDirectory,
      promotionDirectory
    })).rejects.toMatchObject({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    });

    await writeProviderAnswerPersistedRouteCapture({
      capture,
      outputReviewDirectory: outputDirectory,
      promotionDirectory
    });
    expect((await readdir(outputDirectory)).sort()).toEqual([
      KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
      KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
      KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE
    ].sort());
    for (const fileName of await readdir(outputDirectory)) {
      expect((await lstat(join(outputDirectory, fileName))).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(promotionDirectory)).toEqual([
      KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
    ]);
    expect((await lstat(join(
      promotionDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
    ))).mode & 0o777).toBe(0o600);
    const auditedPromotion = await readProviderAnswerPersistedRouteProof({
      inputReviewDirectory: inputDirectory,
      outputReviewDirectory: outputDirectory,
      promotionDirectory
    });
    expect(auditedPromotion.receipt.executionReceiptSha256).toBe(
      capture.receipt.executionReceiptSha256
    );
    expect(auditedPromotion.report).toEqual(capture.report);
    expect(auditedPromotion.releaseTrustEligible).toBe(false);
    expect(validatedProviderAnswerPersistedRouteReceiptSha256(capture.promotion)).toBe(
      capture.receipt.executionReceiptSha256
    );
    expect(() => validatedProviderAnswerPersistedRouteReceiptSha256(
      auditedPromotion
    )).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    }));
    expect(() => validatedProviderAnswerPersistedRouteReceiptSha256({
      receipt: capture.promotion.receipt,
      report: capture.promotion.report
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    }));

    const forgedOpaqueReceiptBase = {
      ...capture.receipt,
      entries: capture.receipt.entries.map((entry, index) => index === 0
        ? { ...entry, persistedEvidenceReceiptSha256: "f".repeat(64) }
        : entry)
    };
    const {
      executionReceiptSha256: _forgedOpaqueHash,
      ...forgedOpaqueReceiptBody
    } = forgedOpaqueReceiptBase;
    const forgedOpaqueReceipt = {
      ...forgedOpaqueReceiptBody,
      executionReceiptSha256: canonicalSha256(forgedOpaqueReceiptBody)
    };
    expect(() => assertProviderAnswerPersistedRouteReceipt(
      forgedOpaqueReceipt
    )).not.toThrow();
    await writeProviderAnswerReviewArtifacts({
      ...capture.artifacts,
      reviewDirectory: forgedOutputDirectory
    });
    const forgedReceiptPath = join(
      forgedPromotionDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
    );
    await writeFile(forgedReceiptPath, `${JSON.stringify(
      forgedOpaqueReceipt,
      null,
      2
    )}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(forgedReceiptPath, 0o600);
    const forgedDiskAudit = await readProviderAnswerPersistedRouteProof({
      inputReviewDirectory: inputDirectory,
      outputReviewDirectory: forgedOutputDirectory,
      promotionDirectory: forgedPromotionDirectory
    });
    expect(forgedDiskAudit.releaseTrustEligible).toBe(false);
    expect(() => validatedProviderAnswerPersistedRouteReceiptSha256(
      forgedDiskAudit
    )).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_persisted_route_receipt_invalid"
    }));
    expect(storage.objects.size).toBe(0);
    await expect(prisma.user.count({
      where: { id: { startsWith: "provider-answer-persisted-route-user-" } }
    })).resolves.toBe(0);
  }, 120_000);
});
