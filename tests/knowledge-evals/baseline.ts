import { createHash } from "node:crypto";
import { cpus, platform, arch, totalmem } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES } from "../../lib/contracts/knowledge";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SCORE_THRESHOLD
} from "../../lib/server/knowledge/retrievalTypes";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../../lib/server/knowledge/knowledgeBudget";
import {
  knowledgeEvalFixtureSummary,
  knowledgeEvalSources,
  type KnowledgeEvalQuery
} from "./fixtures";

export const KNOWLEDGE_EVAL_VECTOR_DIMENSION = 1_024;
const NEUTRAL_DISTRACTOR_AXES = Object.freeze([42, 43, 44, 45, 46, 47, 48, 49]);

const implementationOwners = Object.freeze([
  "prisma/schema.prisma",
  "lib/contracts/knowledge.ts",
  "lib/server/knowledge/retrievalTypes.ts",
  "lib/server/knowledge/toolExecutor.ts",
  "lib/server/knowledge/prismaRetrievalRepository.ts",
  "lib/server/knowledge/ingestionProcessor.ts",
  "lib/server/parsing/boundary.ts",
  "scripts/knowledge-ocr-fixtures.ts",
  "components/knowledge/KnowledgeLibrary.tsx",
  "components/app-shell/knowledgeLibraryController.ts",
  "tests/e2e/knowledge.spec.ts"
]);

const ordinaryTechnicalMarkers = Object.freeze([
  "activeGeneration",
  "chunkingProfileVersion",
  "currentVersionId",
  "embeddingDeployment",
  "embeddingDeploymentId",
  "embeddedChunks",
  "errorCode",
  "generationId",
  "indexedContentRevision",
  "targetDimension",
  "totalChunks",
  "vectorSpaceFingerprint",
  "visibleFromRevision",
  "visibleUntilRevision"
]);

function sourceAxis(sourceId: string): number {
  const match = /^source-(\d{3})$/u.exec(sourceId);
  const ordinal = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 50) {
    throw new Error("knowledge_eval_source_axis_invalid");
  }
  return ordinal - 1;
}

export function knowledgeEvalSourceVector(sourceId: string): number[] {
  const vector = Array<number>(KNOWLEDGE_EVAL_VECTOR_DIMENSION).fill(0);
  vector[sourceAxis(sourceId)] = 1;
  return vector;
}

export function knowledgeEvalQueryVector(query: KnowledgeEvalQuery): number[] {
  const vector = Array<number>(KNOWLEDGE_EVAL_VECTOR_DIMENSION).fill(0);
  if (query.baselineEmbedding.kind === "neutral") {
    for (const axis of NEUTRAL_DISTRACTOR_AXES) vector[axis] = 1;
    return vector;
  }
  for (const sourceId of query.baselineEmbedding.sourceIds) {
    vector[sourceAxis(sourceId)] = 1;
  }
  return vector;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(body: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = body.indexOf(marker, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + marker.length;
  }
}

async function filesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function routeInventory(root: string): Promise<Array<Readonly<{
  methods: string[];
  path: string;
}>>> {
  const routeRoots = [
    join(root, "app/api/me/knowledge-bases"),
    join(root, "app/api/admin/knowledge"),
    join(root, "app/api/projects")
  ];
  const candidates = (await Promise.all(routeRoots.map(filesRecursively)))
    .flat()
    .filter((path) => path.endsWith("/route.ts"));
  const routes: Array<Readonly<{ methods: string[]; path: string }>> = [];
  for (const path of candidates) {
    const body = await readFile(path, "utf8");
    if (!body.toLocaleLowerCase("en-US").includes("knowledge")) continue;
    const methods = [...body.matchAll(
      /export const (DELETE|GET|PATCH|POST|PUT)\s*=/gu
    )].map((match) => match[1]!).sort();
    routes.push(Object.freeze({
      methods,
      path: relative(root, path)
    }));
  }
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function collectKnowledgeBaselineInventory(
  root = process.cwd()
): Promise<Readonly<{
  callGraphEdges: readonly Readonly<{ from: string; to: string }>[];
  implementationDigests: readonly Readonly<{ path: string; sha256: string }>[];
  knowledgeModels: readonly string[];
  ordinaryRouteMethods: readonly Readonly<{ methods: string[]; path: string }>[];
  ordinaryTechnicalMarkerOccurrences: Readonly<Record<string, number>>;
}>> {
  const bodies = new Map<string, string>();
  for (const path of implementationOwners) {
    bodies.set(path, await readFile(join(root, path), "utf8"));
  }
  const schema = bodies.get("prisma/schema.prisma")!;
  const knowledgeModels = [...schema.matchAll(/^model (Knowledge[A-Za-z0-9]+)/gmu)]
    .map((match) => match[1]!)
    .sort();
  const callGraphEdges = implementationOwners.flatMap((path) => {
    const body = bodies.get(path)!;
    return [...body.matchAll(/from\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]!)
      .filter((target) => target.toLocaleLowerCase("en-US").includes("knowledge"))
      .map((target) => Object.freeze({ from: path, to: target }));
  }).sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const ordinaryBodies = [
    bodies.get("lib/contracts/knowledge.ts")!,
    bodies.get("components/knowledge/KnowledgeLibrary.tsx")!,
    bodies.get("components/app-shell/knowledgeLibraryController.ts")!
  ].join("\n");
  const markerCounts = Object.fromEntries(ordinaryTechnicalMarkers.map((marker) => [
    marker,
    occurrenceCount(ordinaryBodies, marker)
  ]));
  return Object.freeze({
    callGraphEdges: Object.freeze(callGraphEdges),
    implementationDigests: Object.freeze(implementationOwners.map((path) => Object.freeze({
      path,
      sha256: digest(bodies.get(path)!)
    }))),
    knowledgeModels: Object.freeze(knowledgeModels),
    ordinaryRouteMethods: Object.freeze(await routeInventory(root)),
    ordinaryTechnicalMarkerOccurrences: Object.freeze(markerCounts)
  });
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

export async function knowledgeBaselineRuntimeSummary(): Promise<Readonly<{
  architecture: string;
  cgroupCpuQuota: number | null;
  cgroupMemoryLimitMiB: number | null;
  cpuCount: number;
  deploymentProfile: "docker-compose-dev-app-v1" | "unbounded-process";
  nodeVersion: string;
  platform: string;
  totalMemoryMiB: number;
}>> {
  const [cpuMaximum, memoryMaximum] = await Promise.all([
    optionalText("/sys/fs/cgroup/cpu.max"),
    optionalText("/sys/fs/cgroup/memory.max")
  ]);
  const [quotaText, periodText] = cpuMaximum?.split(/\s+/u) ?? [];
  const quota = Number(quotaText);
  const period = Number(periodText);
  const memoryBytes = memoryMaximum === null ? Number.NaN : Number(memoryMaximum);
  const cgroupCpuQuota = Number.isFinite(quota) && Number.isFinite(period) && period > 0
    ? Math.round((quota / period) * 100) / 100
    : null;
  const cgroupMemoryLimitMiB = Number.isFinite(memoryBytes)
    ? Math.round(memoryBytes / 1024 / 1024)
    : null;
  return Object.freeze({
    architecture: arch(),
    cgroupCpuQuota,
    cgroupMemoryLimitMiB,
    cpuCount: cpus().length,
    deploymentProfile: cgroupCpuQuota !== null && cgroupMemoryLimitMiB !== null
      ? "docker-compose-dev-app-v1"
      : "unbounded-process",
    nodeVersion: process.version,
    platform: platform(),
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024)
  });
}

export async function createKnowledgeStaticBaseline(
  root = process.cwd()
): Promise<Readonly<{
  corpus: ReturnType<typeof knowledgeEvalFixtureSummary>;
  currentContract: Readonly<{
    candidateLimit: number;
    executionBudget: typeof DEFAULT_KNOWLEDGE_BUDGET_POLICY;
    explicitSelectionResourceLimit: number;
    fusion: "rrf_k60";
    resultLimit: number;
    resultVersion: number;
    scoreThreshold: number;
    scopeBindingLimit: number;
  }>;
  inventory: Awaited<ReturnType<typeof collectKnowledgeBaselineInventory>>;
  runtime: Awaited<ReturnType<typeof knowledgeBaselineRuntimeSummary>>;
  sourceVectorFixture: Readonly<{
    dimension: number;
    kind: "deterministic-source-oracle-v1";
    sourceCount: number;
  }>;
}>> {
  return Object.freeze({
    corpus: knowledgeEvalFixtureSummary(),
    currentContract: Object.freeze({
      candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
      executionBudget: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      explicitSelectionResourceLimit: KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES,
      fusion: "rrf_k60",
      resultLimit: KNOWLEDGE_RESULT_LIMIT,
      resultVersion: KNOWLEDGE_RESULT_VERSION,
      scoreThreshold: KNOWLEDGE_SCORE_THRESHOLD,
      scopeBindingLimit: KNOWLEDGE_SCOPE_MAX_BINDINGS
    }),
    inventory: await collectKnowledgeBaselineInventory(root),
    runtime: await knowledgeBaselineRuntimeSummary(),
    sourceVectorFixture: Object.freeze({
      dimension: KNOWLEDGE_EVAL_VECTOR_DIMENSION,
      kind: "deterministic-source-oracle-v1",
      sourceCount: knowledgeEvalSources.length
    })
  });
}
