import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import {
  createPrismaEmbeddingRuntime,
  type EmbeddingRuntimeStore
} from "../providerRuntime/embeddingRuntime";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { prisma } from "../prisma";
import { createKnowledgeVectorSpacePin } from "./indexProfile";

export type KnowledgeRunAdmissionBinding = Readonly<{
  baseContentRevision: number;
  embeddingCredentialSource: "default" | "group" | "user";
  embeddingExecutionSnapshot: ProviderExecutionSnapshot;
  embeddingProviderModelId: string;
  indexedContentRevision: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  ordinal: number;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeRunAdmissionPlan = Readonly<{
  bindings: readonly KnowledgeRunAdmissionBinding[];
  fingerprint: string;
  knowledgePlan: KnowledgePlan;
  userId: string;
}>;

export class KnowledgeRunAdmissionError extends Error {
  readonly code = "knowledge_base_not_available" as const;

  constructor() {
    super("knowledge_base_not_available");
    this.name = "KnowledgeRunAdmissionError";
  }
}

export type KnowledgeRunAdmissionStore = EmbeddingRuntimeStore & Pick<
  PrismaClient,
  "knowledgeBase" | "userGroup"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: Omit<KnowledgeRunAdmissionPlan, "fingerprint">): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export async function loadKnowledgeRunAdmissionPlan(
  client: KnowledgeRunAdmissionStore,
  input: Readonly<{ knowledgePlan: KnowledgePlan; userId: string }>
): Promise<KnowledgeRunAdmissionPlan> {
  const decodedKnowledgePlan = decodeKnowledgePlan(input.knowledgePlan);
  if (!decodedKnowledgePlan.ok) throw new KnowledgeRunAdmissionError();
  const knowledgePlan = decodedKnowledgePlan.plan;
  const user = await client.user.findFirst({
    select: { id: true },
    where: { id: input.userId, status: "active" }
  });
  if (!user) throw new KnowledgeRunAdmissionError();
  if (knowledgePlan.baseIds.length === 0) {
    const empty = {
      bindings: [],
      knowledgePlan: { baseIds: [] },
      userId: input.userId
    } satisfies Omit<KnowledgeRunAdmissionPlan, "fingerprint">;
    return { ...empty, fingerprint: fingerprint(empty) };
  }

  const groups = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  const groupIds = groups.map(({ groupId }) => groupId);
  const embeddingRuntime = createPrismaEmbeddingRuntime(client);
  const bindings: KnowledgeRunAdmissionBinding[] = [];

  for (const [ordinal, knowledgeBaseId] of knowledgePlan.baseIds.entries()) {
    const base = await client.knowledgeBase.findFirst({
      select: {
        activeIndexGeneration: {
          select: {
            embeddingConfiguration: true,
            embeddingProviderModelId: true,
            id: true,
            indexedContentRevision: true,
            status: true,
            targetDimension: true,
            vectorSpaceFingerprint: true
          }
        },
        contentRevision: true,
        id: true
      },
      where: {
        archivedAt: null,
        id: knowledgeBaseId,
        OR: [
          { ownerUserId: input.userId },
          {
            publications: {
              some: {
                OR: [
                  { scope: "installation" },
                  ...(groupIds.length > 0
                    ? [{ groupId: { in: groupIds }, scope: "group" as const }]
                    : [])
                ]
              }
            }
          }
        ]
      }
    });
    const generation = base?.activeIndexGeneration;
    if (!base || !generation || generation.status !== "active") {
      throw new KnowledgeRunAdmissionError();
    }

    try {
      const embedding = await embeddingRuntime.resolveForUser({
        providerModelId: generation.embeddingProviderModelId,
        userId: input.userId
      });
      const currentPin = createKnowledgeVectorSpacePin({
        configuration: embedding.configuration,
        deploymentId: generation.embeddingProviderModelId
      });
      const storedFingerprint = generation.vectorSpaceFingerprint.trim();
      if (
        !currentPin?.indexSupported ||
        currentPin.fingerprint !== storedFingerprint ||
        currentPin.targetDimension !== generation.targetDimension ||
        canonicalJson(currentPin.configuration) !== canonicalJson(generation.embeddingConfiguration)
      ) {
        throw new KnowledgeRunAdmissionError();
      }
      bindings.push({
        baseContentRevision: base.contentRevision,
        embeddingCredentialSource: embedding.credentialSource,
        embeddingExecutionSnapshot: embedding.executionSnapshot,
        embeddingProviderModelId: generation.embeddingProviderModelId,
        indexedContentRevision: generation.indexedContentRevision,
        indexGenerationId: generation.id,
        knowledgeBaseId: base.id,
        ordinal,
        targetDimension: generation.targetDimension,
        vectorSpaceFingerprint: storedFingerprint
      });
    } catch (error) {
      if (
        error instanceof KnowledgeRunAdmissionError ||
        error instanceof ProviderAdmissionError
      ) {
        throw new KnowledgeRunAdmissionError();
      }
      throw error;
    }
  }

  const accepted = {
    bindings,
    knowledgePlan: { baseIds: [...knowledgePlan.baseIds] },
    userId: input.userId
  } satisfies Omit<KnowledgeRunAdmissionPlan, "fingerprint">;
  return { ...accepted, fingerprint: fingerprint(accepted) };
}

export function sameKnowledgeRunAdmissionPlan(
  left: KnowledgeRunAdmissionPlan,
  right: KnowledgeRunAdmissionPlan
): boolean {
  return left.fingerprint === right.fingerprint && canonicalJson(left) === canonicalJson(right);
}

export function createKnowledgeRunAdmissionService(
  client: KnowledgeRunAdmissionStore = prisma
) {
  return {
    load(input: Readonly<{ knowledgePlan: KnowledgePlan; userId: string }>) {
      return loadKnowledgeRunAdmissionPlan(client, input);
    }
  };
}

export const knowledgeRunAdmissionService = createKnowledgeRunAdmissionService();
