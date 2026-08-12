import {
  createPrivateKey,
  createPublicKey,
  sign
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  canonicalMemoryQualificationPayload,
  type MemoryCapabilityQualification,
  type MemoryQualificationKey
} from "../lib/evaluation/memory/qualification";
import { memoryEvaluationSha256 } from "../lib/evaluation/memory/canonical";
import {
  memoryAutomaticLearningEvidenceIdentityIsCurrent
} from "../lib/evaluation/memory/automaticLearning";
import type { MemoryEvaluationLanguage } from "../lib/evaluation/memory/contracts";
import type { MemoryExecutionRole } from "../lib/server/memory/execution";
import {
  MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES
} from "../lib/server/memory/learning/betaQualification";

const qualifiedRoles = MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES;
const languages = ["EN", "RU"] as const satisfies readonly MemoryEvaluationLanguage[];
const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;
const exactIsoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type EvidenceFingerprint = Pick<
  MemoryQualificationKey,
  "configFingerprint" |
  "deploymentFingerprint" |
  "modelFingerprint" |
  "providerFingerprint" |
  "vectorSpaceFingerprint"
> & Readonly<{ role: MemoryExecutionRole }>;
type EvidenceVersions = Pick<
  MemoryQualificationKey,
  "pipelineVersion" |
  "policyVersion" |
  "promptVersion" |
  "retrievalConfigFingerprint" |
  "schemaVersion"
> & Readonly<{ role: MemoryExecutionRole }>;

function optionalArgumentValue(prefix: string): string | null {
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length).trim();
  return value || null;
}

function argumentValue(prefix: string): string {
  const value = optionalArgumentValue(prefix);
  if (!value) throw new Error("memory_qualification_registry_argument_missing");
  return value;
}

function privateInputPath(prefix: string): string {
  const privateRoot = resolve(".aiqsa");
  const target = resolve(argumentValue(prefix));
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_qualification_registry_private_path_invalid");
  }
  return target;
}

function privateOutputPath(): string | null {
  const value = optionalArgumentValue("--output=");
  if (!value) return null;
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_qualification_registry_private_path_invalid");
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): string {
  if (typeof value !== "string" || !safeToken.test(value)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  return value;
}

function exactInstant(value: string): string {
  if (!exactIsoInstant.test(value) || new Date(value).toISOString() !== value) {
    throw new Error("memory_qualification_registry_approval_invalid");
  }
  return value;
}

function role(value: unknown): MemoryExecutionRole {
  if (typeof value !== "string" ||
      !qualifiedRoles.includes(value as typeof qualifiedRoles[number])) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  return value as MemoryExecutionRole;
}

function fingerprints(value: unknown): EvidenceFingerprint[] {
  if (!Array.isArray(value)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("memory_qualification_registry_evidence_invalid");
    const roleName = role(item.role);
    const vectorSpaceFingerprint = item.vectorSpaceFingerprint === null
      ? null
      : sha256(item.vectorSpaceFingerprint);
    const embeddingRole = roleName === "MEMORY_DOCUMENT_EMBED" ||
      roleName === "MEMORY_QUERY_EMBED";
    if (embeddingRole !== (vectorSpaceFingerprint !== null)) {
      throw new Error("memory_qualification_registry_evidence_invalid");
    }
    return {
      configFingerprint: sha256(item.configFingerprint),
      deploymentFingerprint: sha256(item.deploymentFingerprint),
      modelFingerprint: sha256(item.modelFingerprint),
      providerFingerprint: sha256(item.providerFingerprint),
      role: roleName,
      vectorSpaceFingerprint
    };
  });
}

function versions(value: unknown): EvidenceVersions[] {
  if (!Array.isArray(value)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("memory_qualification_registry_evidence_invalid");
    return {
      pipelineVersion: token(item.pipelineVersion),
      policyVersion: token(item.policyVersion),
      promptVersion: token(item.promptVersion),
      retrievalConfigFingerprint: token(item.retrievalConfigFingerprint),
      role: role(item.role),
      schemaVersion: token(item.schemaVersion)
    };
  });
}

function uniqueByRole<T extends Readonly<{ role: MemoryExecutionRole }>>(
  values: readonly T[]
): ReadonlyMap<MemoryExecutionRole, T> {
  const result = new Map(values.map((value) => [value.role, value]));
  if (values.length !== qualifiedRoles.length ||
      result.size !== qualifiedRoles.length ||
      qualifiedRoles.some((required) => !result.has(required))) {
    throw new Error("memory_qualification_registry_role_coverage_incomplete");
  }
  return result;
}

async function main(): Promise<void> {
  const evidencePath = privateInputPath("--evidence=");
  const privateKeyPath = privateInputPath("--private-key=");
  const outputPath = privateOutputPath();
  const approvedAt = exactInstant(argumentValue("--approved-at="));
  const expiresAt = exactInstant(argumentValue("--expires-at="));
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    throw new Error("memory_qualification_registry_approval_invalid");
  }
  const approvedBy = token(argumentValue("--approved-by="));
  const approvalId = token(argumentValue("--approval-id="));
  const approvalDate = approvedAt.slice(0, 10).replaceAll("-", "");

  const wrapper = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
  if (!isRecord(wrapper) || !isRecord(wrapper.evidence)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  const evidence = wrapper.evidence;
  if (!isRecord(evidence.corpus) || !isRecord(evidence.suite) ||
      !isRecord(evidence.quality) || !isRecord(evidence.adapter) ||
      !isRecord(evidence.dependencies) || !isRecord(evidence.hardGates) ||
      !isRecord(evidence.quality.supportingRoles) ||
      !isRecord(evidence.quality.supportingRoles.episode) ||
      !isRecord(evidence.quality.supportingRoles.verification)) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  const episode = evidence.quality.supportingRoles.episode;
  const verification = evidence.quality.supportingRoles.verification;
  if (evidence.passed !== true || evidence.sanitizedAggregatesOnly !== true ||
      !memoryAutomaticLearningEvidenceIdentityIsCurrent({
        corpusHash: evidence.corpus.hash,
        corpusVersion: evidence.corpus.version,
        evaluatorVersion: evidence.adapter.version,
        evidenceVersion: evidence.evidenceVersion,
        extractionScorerVersion: evidence.suite.extractionScorer,
        scorerVersion: evidence.suite.scorer,
        suiteVersion: evidence.suite.version
      }) ||
      evidence.corpus.split !== "HOLDOUT" ||
      !Number.isSafeInteger(evidence.corpus.evaluatedFixtures) ||
      Number(evidence.corpus.evaluatedFixtures) <= 0 ||
      evidence.corpus.evaluatedFixtures !== evidence.corpus.fullSplitFixtures ||
      evidence.suite.selectedCasesPerCohort !== null ||
      evidence.suite.selectedCohorts !== null ||
      evidence.quality.coverageComplete !== true ||
      evidence.quality.gatePassed !== true ||
      (["EN", "RU"] as const).some((language) => {
        const episodeLanguage = episode[language];
        const verificationLanguage = verification[language];
        return !isRecord(episodeLanguage) || episodeLanguage.passed !== true ||
          !isRecord(verificationLanguage) || verificationLanguage.passed !== true;
      }) ||
      evidence.adapter.liveProvider !== true ||
      !isRecord(evidence.dependencies.embeddingHoldout) ||
      evidence.hardGates.localOnlyProviderCalls !== 0 ||
      evidence.hardGates.secretOrHighlySensitivePromotions !== 0 ||
      evidence.hardGates.unacceptedDestinationCalls !== 0) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  const evidenceDigest = sha256(wrapper.evidenceDigest);
  if (memoryEvaluationSha256(evidence) !== evidenceDigest) {
    throw new Error("memory_qualification_registry_evidence_invalid");
  }
  const corpusHash = sha256(evidence.corpus.hash);
  const corpusVersion = token(evidence.corpus.version);
  const scorerVersion = token(evidence.suite.scorer);
  const suiteVersion = token(evidence.suite.version);
  const byRoleFingerprint = uniqueByRole(fingerprints(
    evidence.adapter.fingerprints
  ));
  const byRoleVersions = uniqueByRole(versions(evidence.versions));

  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("memory_qualification_registry_signing_key_invalid");
  }
  const registry: MemoryCapabilityQualification[] = [];
  for (const roleName of qualifiedRoles) {
    const fingerprint = byRoleFingerprint.get(roleName)!;
    const roleVersions = byRoleVersions.get(roleName)!;
    for (const language of languages) {
      const qualificationId = token(
        `memory-beta-${approvalDate}-${roleName.toLowerCase().replaceAll("_", "-")}-${language.toLowerCase()}`
      );
      const unsigned: MemoryCapabilityQualification = {
        approval: {
          approvalId,
          approved: true,
          approvedAt,
          approvedBy,
          expiresAt,
          signature: "pending"
        },
        evidenceDigest,
        key: {
          configFingerprint: fingerprint.configFingerprint,
          corpusHash,
          corpusVersion,
          deploymentFingerprint: fingerprint.deploymentFingerprint,
          language,
          modelFingerprint: fingerprint.modelFingerprint,
          pipelineVersion: roleVersions.pipelineVersion,
          policyVersion: roleVersions.policyVersion,
          promptVersion: roleVersions.promptVersion,
          providerFingerprint: fingerprint.providerFingerprint,
          retrievalConfigFingerprint: roleVersions.retrievalConfigFingerprint,
          role: roleName,
          schemaVersion: roleVersions.schemaVersion,
          scorerVersion,
          suiteVersion,
          vectorSpaceFingerprint: fingerprint.vectorSpaceFingerprint
        },
        qualificationId
      };
      registry.push({
        ...unsigned,
        approval: {
          ...unsigned.approval,
          signature: sign(
            null,
            Buffer.from(canonicalMemoryQualificationPayload(unsigned), "utf8"),
            privateKey
          ).toString("base64url")
        }
      });
    }
  }

  const publicKey = createPublicKey(privateKey).export({
    format: "der",
    type: "spki"
  }).toString("base64");
  const output = `${JSON.stringify({ publicKey, registry }, null, 2)}\n`;
  if (outputPath) {
    await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
    await writeFile(outputPath, output, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      entries: registry.length,
      outputPath: relative(process.cwd(), outputPath)
    }, null, 2)}\n`);
  } else {
    process.stdout.write(output);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error
    ? error.message
    : "memory_qualification_registry_build_failed"}\n`);
  process.exitCode = 1;
});
