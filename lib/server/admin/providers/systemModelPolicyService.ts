import { loadInstallationImageProviderRole } from "../../providerRuntime/admission";
import { normalizeImageGenerationParameters, type ImageGenerationParameters } from "../../../contracts/imageGeneration";
import { hasVerifiedImageCapability } from "../../providers/imageGenerationEvidence";
import { hasVerifiedDedicatedProtocol } from "../../providers/systemRoleEvidence";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminSystemModelIneligibilityReason,
  AdminSystemModelIneligibleCandidate,
  AdminSystemModelPolicyCatalog,
  SystemModelVerificationRole
} from "../../../contracts/adminSystemModelPolicy";
import {
  loadInstallationAnswerProviderRole,
  loadInstallationRerankerProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import { systemModelRoleEligible } from "../../providerRuntime/systemModelCapabilities";
import { createChatTitleModelRoleResolver } from "../../providerRuntime/chatTitleModelRole";
import { createChatPdfModelRoleResolver } from "../../providerRuntime/chatPdfModelRole";
import { pdfInputVerificationStatus, supportsPdfInputAdapter } from "../../providers/pdfInputEvidence";
import { hasVerifiedVisionInput } from "../../providers/visionInputEvidence";
import { createRerankerModelRoleResolver } from "../../providerRuntime/rerankerModelRole";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { configuredModelParameterControls, supportsConfiguredReasoningEffort } from "../../providers/providerModelCapabilities";
import {
  serializeAdminAnswerModel,
  type AdminAnswerModelRow
} from "./modelPolicyService";
import { structuredOutputVerificationStatus } from "../../providers/structuredOutputEvidence";
import {
  forcedToolCallVerificationStatus,
  supportsForcedToolCallProbe
} from
  "../../providers/forcedToolCallEvidence";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { decodeCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { RERANKER_ROUTE_POLICY_VERSION } from "../../../domain/rerankerModels";
import {
  approvedRerankerDeploymentByProviderModelId,
  approvedRerankerDeployments
} from "./approvedRerankers";

type SystemModelRow = AdminAnswerModelRow & {
  activeCredentialChecks: Array<{
    connectionVersion: number;
    credentialId: string;
    credentialVersionId: string;
    evidence: unknown;
    modelVersion: number;
    status: "available" | "unavailable";
  }>;
  connection: AdminAnswerModelRow["connection"] & {
    defaultCredential: null | {
      activeVersion: null | { id: string; revokedAt?: Date | null };
      enabled?: boolean;
      id: string;
    };
  };
};

export type AdminSystemModelPolicyServiceErrorCode =
  | "system_model_policy_reasoning_unavailable"
  | "system_model_policy_stale"
  | "system_model_policy_image_parameters_invalid"
  | "system_model_policy_structured_output_unsupported"
  | "system_model_policy_target_unavailable"
  | "system_model_policy_verification_failed";

export class AdminSystemModelPolicyServiceError extends Error {
  constructor(readonly code: AdminSystemModelPolicyServiceErrorCode) {
    super(code);
    this.name = "AdminSystemModelPolicyServiceError";
  }
}

type RoleLoader = typeof loadInstallationAnswerProviderRole;
type RerankerRoleLoader = typeof loadInstallationRerankerProviderRole;

type ActiveRefresh = (input: Readonly<{
  confirmPaidRequest: true;
  capabilityRole?: SystemModelVerificationRole;
  connectionId: string;
  credentialId: string;
  providerModelId: string;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  evidence: unknown;
  status: "available" | "unavailable";
}>>;

function serializeSystemModel(row: SystemModelRow) {
  let pdfInput: ReturnType<typeof pdfInputVerificationStatus> = "not_verified";
  let visionInput: "not_verified" | "verified" = "not_verified";
  let reasoningEfforts: string[] = [];
  let defaultReasoningEffort: string | null = null;
  let forcedToolCall: "not_verified" | "unsupported" | "verified" = "unsupported";
  let structuredOutput: "not_verified" | "unsupported" | "verified" = "unsupported";
  try {
    const configuration = normalizeProviderModelConfiguration(row.activeConfig);
    const control = configuredModelParameterControls(configuration, row.connection.family ?? "").reasoningEffort;
    if (control.supported) {
      reasoningEfforts = [...control.options];
      defaultReasoningEffort = control.defaultValue;
    }
    const credential = row.connection.defaultCredential;
    const check = credential?.activeVersion && credential.enabled !== false &&
      !credential.activeVersion.revokedAt
      ? row.activeCredentialChecks.find((candidate) =>
          candidate.connectionVersion === row.connection.activeVersion &&
          candidate.credentialId === credential.id &&
          candidate.credentialVersionId === credential.activeVersion!.id &&
          candidate.modelVersion === row.activeVersion &&
          candidate.status === "available")
      : null;
    pdfInput = pdfInputVerificationStatus(check?.evidence, configuration);
    visionInput = hasVerifiedVisionInput(check?.evidence, configuration)
      ? "verified" : "not_verified";
    structuredOutput = structuredOutputVerificationStatus(
      check?.evidence,
      configuration
    );
    forcedToolCall = forcedToolCallVerificationStatus(
      check?.evidence,
      configuration
    );
  } catch {
    // An unavailable retained target remains inspectable without trusting its
    // stale or malformed capability payload.
  }
  return {
    ...serializeAdminAnswerModel(row),
    pdfInput,
    visionInput,
    defaultReasoningEffort,
    forcedToolCall,
    reasoningEfforts,
    structuredOutput
  };
}

function defaultCredentialUsable(row: SystemModelRow): boolean {
  const credential = row.connection.defaultCredential;
  return Boolean(credential?.activeVersion && credential.enabled !== false &&
    !credential.activeVersion.revokedAt);
}

function answerDeploymentActive(row: SystemModelRow): boolean {
  if (!row.enabled || row.activeVersion < 1 || !row.activatedAt || !row.connection.enabled ||
    row.connection.activeVersion < 1 || !row.connection.activatedAt || !row.connection.activeConfig) return false;
  try { return normalizeProviderModelConfiguration(row.activeConfig).modelClass === "answer"; }
  catch { return false; }
}

/** Why an answer deployment is not ready for a generative role. Only
 * `not_checked` can be fixed from the role picker; the others need provider
 * work first, so the picker can explain them without guessing. */
function roleIneligibility(
  row: SystemModelRow,
  serialized: ReturnType<typeof serializeSystemModel>
): Partial<Record<"chat_titles" | "direct_pdf" | "memory" | "vision", Pick<AdminSystemModelIneligibleCandidate, "reason" | "requirement">>> {
  if (!answerDeploymentActive(row)) {
    return { chat_titles: { reason: "model_disabled" }, direct_pdf: { reason: "model_disabled" }, memory: { reason: "model_disabled" }, vision: { reason: "model_disabled" } };
  }
  const model = normalizeProviderModelConfiguration(row.activeConfig);
  const credential = row.connection.defaultCredential;
  const credentialUsable = defaultCredentialUsable(row);
  const check = credentialUsable && credential?.activeVersion ? row.activeCredentialChecks.find((candidate) =>
    candidate.connectionVersion === row.connection.activeVersion && candidate.modelVersion === row.activeVersion &&
    candidate.credentialId === credential.id && candidate.credentialVersionId === credential.activeVersion!.id && candidate.status === "available") : undefined;
  const evidence = check?.evidence && typeof check.evidence === "object" ? check.evidence as Record<string, unknown> : {};
  const compatibility = evidence.compatibility && typeof evidence.compatibility === "object"
    ? evidence.compatibility as Record<string, unknown> : {};
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  const rejection = (key: string): AdminSystemModelIneligibilityReason =>
    setup && (setup.checks as Record<string, string>)[key] !== "rejected" ? "not_checked" :
    compatibility[key] === "not_supported" ? "probe_rejected" : "not_checked";
  const configuredCapabilityReason = (enabled: boolean | undefined, key: "toolCalling" | "vision" | "directPdf"):
    AdminSystemModelIneligibilityReason => {
    if (!credentialUsable) return "no_default_credential";
    if (enabled) return rejection(key);
    // Only unresolved initial checks explain a false bootstrap flag. A
    // previously verified check cannot override an administrator's disable.
    const status = setup?.checks[key];
    return status === "rejected" ? "probe_rejected"
      : status === "incomplete" || status === "not_checked" ? "not_checked"
      : "capability_disabled";
  };
  const reasons: ReturnType<typeof roleIneligibility> = {};
  if (serialized.structuredOutput !== "verified") {
    reasons.chat_titles = {
      reason: !supportsStructuredOutputAdapter(model.adapterKind) ? "adapter_unsupported"
        : !credentialUsable ? "no_default_credential" : rejection("structuredOutput"),
      requirement: "structured_output"
    };
  }
  if (serialized.structuredOutput !== "verified" || serialized.forcedToolCall !== "verified") {
    reasons.memory = !supportsStructuredOutputAdapter(model.adapterKind)
      ? { reason: "adapter_unsupported", requirement: "structured_output" }
      : !supportsForcedToolCallProbe(model.adapterKind)
        ? { reason: "adapter_unsupported", requirement: "forced_tool_call" }
        : !credentialUsable
          ? { reason: "no_default_credential" }
          : !model.capabilities.toolCalling
            ? { reason: configuredCapabilityReason(false, "toolCalling"), requirement: "tool_calling" }
            : serialized.structuredOutput !== "verified"
              ? { reason: rejection("structuredOutput"), requirement: "structured_output" }
              : { reason: rejection("forcedToolCall"), requirement: "forced_tool_call" };
  }
  if (serialized.visionInput !== "verified") {
    reasons.vision = { reason: configuredCapabilityReason(model.capabilities.vision, "vision"), requirement: "vision" };
  }
  if (serialized.pdfInput !== "verified") {
    reasons.direct_pdf = { reason: !supportsPdfInputAdapter(model.adapterKind) ? "adapter_unsupported"
      : configuredCapabilityReason(model.capabilities.nativePdfInput, "directPdf"), requirement: "direct_pdf" };
  }
  return reasons;
}

function serializeImageModel(row: SystemModelRow) {
  try {
    const model = normalizeProviderModelConfiguration(row.activeConfig);
    if (model.modelClass !== "image" || !model.image) return null;
    const credential = row.connection.defaultCredential;
    const active = row.enabled && row.activeVersion > 0 && row.connection.enabled && row.connection.activeVersion > 0 &&
      Boolean(row.activatedAt && row.connection.activatedAt && row.connection.activeConfig) && defaultCredentialUsable(row);
    const check = active && credential?.activeVersion ? row.activeCredentialChecks.find((entry) =>
      entry.status === "available" && entry.connectionVersion === row.connection.activeVersion && entry.modelVersion === row.activeVersion &&
      entry.credentialId === credential.id && entry.credentialVersionId === credential.activeVersion!.id) : null;
    return { ...serializeAdminAnswerModel(row), upstreamModelId: model.upstreamModelId, image: model.image,
      defaultParameters: normalizeImageGenerationParameters(model.defaultParams, model.image, model.upstreamModelId),
      generation: hasVerifiedDedicatedProtocol(check?.evidence, model) && hasVerifiedImageCapability(check?.evidence, model, "imageGeneration"),
      editing: hasVerifiedDedicatedProtocol(check?.evidence, model) && hasVerifiedImageCapability(check?.evidence, model, "imageEditing") };
  } catch { return null; }
}

function rerankerModelAvailable(row: AdminAnswerModelRow): boolean {
  if (!row.enabled || row.activeVersion < 1 || row.activatedAt === null ||
    row.activeConfig === null || !row.connection.enabled ||
    row.connection.activeVersion < 1 || row.connection.activatedAt === null ||
    row.connection.activeConfig === null) return false;
  try {
    const configuration = normalizeProviderModelConfiguration(row.activeConfig);
    return configuration.modelClass === "reranker" &&
      configuration.adapterKind === "openrouter_rerank" &&
      configuration.answerSelectable === false;
  } catch {
    return false;
  }
}

function serializeRerankerModel(row: AdminAnswerModelRow) {
  return serializeAdminAnswerModel(row);
}

function supportsReasoningEffort(
  role: Awaited<ReturnType<RoleLoader>>,
  effort: string
): boolean {
  return supportsConfiguredReasoningEffort(role.snapshot.model, role.snapshot.providerFamily, effort);
}

export function createAdminSystemModelPolicyService(
  prisma: PrismaClient,
  dependencies: Readonly<{
    loadRole?: RoleLoader;
    loadRerankerRole?: RerankerRoleLoader;
    refreshActive?: ActiveRefresh;
    resolveRerankerRole?: ReturnType<typeof createRerankerModelRoleResolver>["resolve"];
    resolveChatTitleRole?: ReturnType<typeof createChatTitleModelRoleResolver>["resolve"];
    resolveChatPdfRole?: ReturnType<typeof createChatPdfModelRoleResolver>["resolve"];
    resolveRole?: ReturnType<typeof createSystemModelRoleResolver>["resolve"];
  }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationAnswerProviderRole;
  const resolveRole = dependencies.resolveRole ??
    createSystemModelRoleResolver(prisma, { loadRole }).resolve;
  const resolveChatTitleRole = dependencies.resolveChatTitleRole ??
    createChatTitleModelRoleResolver(prisma, loadRole).resolve;
  const resolveChatPdfRole = dependencies.resolveChatPdfRole ??
    createChatPdfModelRoleResolver(prisma, loadRole).resolve;
  const loadRerankerRole = dependencies.loadRerankerRole ??
    loadInstallationRerankerProviderRole;
  const resolveRerankerRole = dependencies.resolveRerankerRole ??
    createRerankerModelRoleResolver(prisma, {
      loadRole: loadRerankerRole
    }).resolve;

  return {
    async list(): Promise<AdminSystemModelPolicyCatalog> {
      const rerankerResolution = await resolveRerankerRole();
      const [policy, rows, rerankerRows, resolution, chatPdfResolution, chatTitleResolution, chatPdfNativeResolution] =
        await Promise.all([
        prisma.systemModelPolicy.findUnique({
          include: {
            providerModel: {
              include: {
                activeCredentialChecks: {
                  select: {
                    connectionVersion: true,
                    credentialId: true,
                    credentialVersionId: true,
                    evidence: true,
                    modelVersion: true,
                    status: true
                  }
                },
                connection: {
                  include: {
                    defaultCredential: {
                      include: { activeVersion: { select: { id: true, revokedAt: true } } }
                    }
                  }
                }
              }
            },
            chatTitleProviderModel: {
              include: {
                activeCredentialChecks: {
                  select: {
                    connectionVersion: true,
                    credentialId: true,
                    credentialVersionId: true,
                    evidence: true,
                    modelVersion: true,
                    status: true
                  }
                },
                connection: {
                  include: {
                    defaultCredential: {
                      include: { activeVersion: { select: { id: true, revokedAt: true } } }
                    }
                  }
                }
              }
            },
            chatPdfProviderModel: {
              include: {
                activeCredentialChecks: {
                  select: {
                    connectionVersion: true,
                    credentialId: true,
                    credentialVersionId: true,
                    evidence: true,
                    modelVersion: true,
                    status: true
                  }
                },
                connection: {
                  include: {
                    defaultCredential: {
                      include: { activeVersion: { select: { id: true, revokedAt: true } } }
                    }
                  }
                }
              }
            },
            chatPdfNativeProviderModel: {
              include: {
                activeCredentialChecks: {
                  select: {
                    connectionVersion: true,
                    credentialId: true,
                    credentialVersionId: true,
                    evidence: true,
                    modelVersion: true,
                    status: true
                  }
                },
                connection: {
                  include: {
                    defaultCredential: {
                      include: { activeVersion: { select: { id: true, revokedAt: true } } }
                    }
                  }
                }
              }
            },
            rerankerProviderModel: {
              include: { connection: true }
            },
            updatedBy: { select: { displayName: true, id: true } }
          },
          where: { id: "installation" }
        }),
        prisma.providerModel.findMany({
          include: {
            activeCredentialChecks: {
              select: {
                connectionVersion: true,
                credentialId: true,
                credentialVersionId: true,
                evidence: true,
                modelVersion: true,
                status: true
              }
            },
            connection: {
              include: {
                defaultCredential: {
                  include: { activeVersion: { select: { id: true, revokedAt: true } } }
                }
              }
            }
          },
          orderBy: [
            { connection: { displayName: "asc" } },
            { displayName: "asc" },
            { id: "asc" }
          ],
          where: { modelClass: "answer" }
        }),
        prisma.providerModel.findMany({
          include: { connection: true },
          orderBy: [
            { connection: { displayName: "asc" } },
            { displayName: "asc" },
            { id: "asc" }
          ],
          where: { modelClass: "reranker" }
        }),
        resolveRole(),
        resolveChatPdfRole(),
        resolveChatTitleRole(),
        resolveChatPdfRole("pdf_reader")
      ]);
      if (!policy) throw new Error("installation_system_model_policy_missing");
      const imageRows = await prisma.providerModel.findMany({
        where: { modelClass: "image" }, orderBy: [{ displayName: "asc" }, { id: "asc" }],
        include: { activeCredentialChecks: true, connection: { include: { defaultCredential: { include: { activeVersion: true } } } } }
      });
      const imageModels = imageRows.map((row) => serializeImageModel(row as SystemModelRow)).filter((row) => row !== null);
      const selectedImage = imageModels.find((row) => row.id === policy.imageProviderModelId) ?? null;
      let imageParameters: ImageGenerationParameters = {};
      let imageAvailable = Boolean(selectedImage && (selectedImage.generation || selectedImage.editing));
      if (selectedImage) {
        try {
          imageParameters = normalizeImageGenerationParameters(policy.imageParamsJson ?? {}, selectedImage.image, selectedImage.upstreamModelId);
          normalizeImageGenerationParameters({ ...selectedImage.defaultParameters, ...imageParameters }, selectedImage.image, selectedImage.upstreamModelId);
        }
        catch { imageAvailable = false; }
      }
      const models = rows as SystemModelRow[];
      const typedRerankerRows = rerankerRows as AdminAnswerModelRow[];
      const selectedRerankerId = policy.rerankerProviderModelId;
      const routeIds = selectedRerankerId
        ? approvedRerankerDeploymentByProviderModelId(selectedRerankerId)
          ? [
              selectedRerankerId,
              ...approvedRerankerDeployments
                .map(({ providerModelId }) => providerModelId)
                .filter((providerModelId) => providerModelId !== selectedRerankerId)
            ]
          : [selectedRerankerId]
        : [];
      const availableRerankerIds = new Set(rerankerResolution.ok
        ? (rerankerResolution.routes ?? [{
            providerModelId: rerankerResolution.providerModelId,
            role: rerankerResolution.role
          }]).map(({ providerModelId }) => providerModelId)
        : []);
      const rerankerRoute = routeIds.flatMap((providerModelId, position) => {
        const row = typedRerankerRows.find(({ id }) => id === providerModelId);
        if (!row) return [];
        return [{
          ...serializeRerankerModel(row),
          available: availableRerankerIds.has(providerModelId),
          position,
          relevanceScoreFloor:
            approvedRerankerDeploymentByProviderModelId(providerModelId)
              ?.preset.relevanceScoreFloor ?? null,
          role: position === 0 ? "primary" as const : "fallback" as const
        }];
      });
      const deployments = models.filter(answerDeploymentActive).map(serializeSystemModel);
      const ineligible: AdminSystemModelPolicyCatalog["ineligible"] = {
        chat_titles: [],
        direct_pdf: [],
        memory: [],
        vision: []
      };
      for (const row of models) {
        const serialized = deployments.find((model) => model.id === row.id) ?? serializeSystemModel(row);
        const reasons = roleIneligibility(row, serialized);
        for (const role of ["chat_titles", "memory", "vision", "direct_pdf"] as const) {
          const reason = reasons[role];
          if (reason) ineligible[role].push({ ...serialized, ...reason });
        }
      }
      const rerankerCandidates = [];
      for (const row of typedRerankerRows.filter(rerankerModelAvailable)) {
        try {
          await loadRerankerRole(prisma, { providerModelId: row.id });
          rerankerCandidates.push(serializeRerankerModel(row));
        } catch (error) {
          if (!(error instanceof ProviderAdmissionError)) throw error;
        }
      }
      return {
        candidates: deployments.filter((model) => model.structuredOutput === "verified" &&
          model.forcedToolCall === "verified"),
        titleCandidates: deployments.filter((model) => model.structuredOutput === "verified"),
        documentCandidates: deployments.filter((model) => model.pdfInput === "verified" || model.visionInput === "verified"),
        verificationCandidates: deployments,
        ineligible,
        rerankerCandidates,
        imageCandidates: imageModels.filter((model) => model.generation || model.editing),
        policy: {
          imageModel: selectedImage ? { ...selectedImage, available: imageAvailable } : null,
          imageParameters,
          chatTitleReasoningEffort: policy.chatTitleReasoningEffort ?? null,
          chatTitleModel: policy.chatTitleProviderModel ? {
            ...serializeSystemModel(policy.chatTitleProviderModel as SystemModelRow),
            available: chatTitleResolution.ok && chatTitleResolution.providerModelId === policy.chatTitleProviderModelId &&
              chatTitleResolution.policyVersion === policy.version
          } : null,
          chatPdfReasoningEffort: policy.chatPdfReasoningEffort ?? null,
          chatPdfProcessingMode: (policy.chatPdfProcessingMode ?? "PREFER_CHAT_MODEL").toLowerCase() as "prefer_chat_model" | "use_pdf_reader" | "read_page_images",
          chatPdfFallbackMethod: (policy.chatPdfFallbackMethod ?? "PAGE_IMAGES") === "PDF_READER" ? "pdf_reader" : "page_images",
          chatPdfModel: policy.chatPdfProviderModel ? {
            ...serializeSystemModel(policy.chatPdfProviderModel as SystemModelRow),
            available: chatPdfResolution.ok && chatPdfResolution.providerModelId === policy.chatPdfProviderModelId &&
              chatPdfResolution.policyVersion === policy.version
          } : null,
          chatPdfNativeReasoningEffort: policy.chatPdfNativeReasoningEffort ?? null,
          chatPdfNativeModel: policy.chatPdfNativeProviderModel ? {
            ...serializeSystemModel(policy.chatPdfNativeProviderModel as SystemModelRow),
            available: chatPdfNativeResolution.ok && chatPdfNativeResolution.providerModelId === policy.chatPdfNativeProviderModelId &&
              chatPdfNativeResolution.policyVersion === policy.version
          } : null,
          reasoningEffort: policy.reasoningEffort,
          rerankerModel: policy.rerankerProviderModel
            ? {
                ...serializeRerankerModel(
                  policy.rerankerProviderModel as AdminAnswerModelRow
                ),
                available: availableRerankerIds.has(
                  policy.rerankerProviderModelId as string
                ) && rerankerResolution.ok &&
                  rerankerResolution.policyVersion === policy.version
              }
            : null,
          rerankerRoute: {
            entries: rerankerRoute,
            policyVersion: RERANKER_ROUTE_POLICY_VERSION
          },
          systemModel: policy.providerModel
            ? {
                ...serializeSystemModel(
                  policy.providerModel as SystemModelRow
                ),
                available: resolution.ok &&
                  resolution.providerModelId === policy.providerModelId &&
                  resolution.policyVersion === policy.version
              }
            : null,
          updatedAt: policy.updatedAt.toISOString(),
          updatedBy: policy.updatedBy,
          version: policy.version
        }
      };
    },

    async verifyRole(input: Readonly<{
      providerModelId: string;
      role: SystemModelVerificationRole;
      signal?: AbortSignal;
    }>): Promise<void> {
      const model = await prisma.providerModel.findUnique({
        include: { activeCredentialChecks: true, connection: { include: { defaultCredential: { include: { activeVersion: true } } } } },
        where: { id: input.providerModelId }
      });
      const credential = model?.connection.defaultCredential;
      if (!model?.enabled || !model.connection.enabled || !model.activeConfig ||
        !model.connection.activeConfig || model.activeVersion < 1 || model.connection.activeVersion < 1 ||
        !credential?.enabled || !credential.activeVersion || credential.activeVersion.revokedAt) {
        throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
      }
      const configuration = normalizeProviderModelConfiguration(model.activeConfig);
      if ((input.role === "chat_titles" && !supportsStructuredOutputAdapter(configuration.adapterKind)) ||
        (input.role === "memory" && (!supportsStructuredOutputAdapter(configuration.adapterKind) ||
        !supportsForcedToolCallProbe(configuration.adapterKind))) ||
        (input.role === "embedding" ? configuration.modelClass !== "embedding" :
         input.role === "reranker" ? configuration.modelClass !== "reranker" : input.role === "image" ? configuration.modelClass !== "image" : configuration.modelClass !== "answer")) {
        throw new AdminSystemModelPolicyServiceError("system_model_policy_structured_output_unsupported");
      }
      const checked = model.activeCredentialChecks.find((check) => check.status === "available" &&
        check.connectionVersion === model.connection.activeVersion && check.modelVersion === model.activeVersion &&
        check.credentialId === credential.id && check.credentialVersionId === credential.activeVersion!.id);
      const alreadyVerified = input.role === "memory"
        ? structuredOutputVerificationStatus(checked?.evidence, configuration) === "verified" &&
          forcedToolCallVerificationStatus(checked?.evidence, configuration) === "verified"
        : input.role === "chat_titles" ? structuredOutputVerificationStatus(checked?.evidence, configuration) === "verified"
        : input.role === "vision" ? hasVerifiedVisionInput(checked?.evidence, configuration)
        : input.role === "direct_pdf" ? pdfInputVerificationStatus(checked?.evidence, configuration) === "verified"
        : hasVerifiedDedicatedProtocol(checked?.evidence, configuration);
      if (alreadyVerified) return;
      try {
        if (!dependencies.refreshActive) throw new Error("system_role_verifier_unavailable");
        const result = await dependencies.refreshActive({
          capabilityRole: input.role, confirmPaidRequest: true,
          connectionId: model.connectionId, credentialId: credential.id,
          providerModelId: model.id, signal: input.signal
        });
        const valid = input.role === "memory"
          ? structuredOutputVerificationStatus(result.evidence, configuration) === "verified" &&
            forcedToolCallVerificationStatus(result.evidence, configuration) === "verified"
          : input.role === "chat_titles" ? result.status === "available" && structuredOutputVerificationStatus(result.evidence, configuration) === "verified"
          : input.role === "vision" ? hasVerifiedVisionInput(result.evidence, configuration)
          : input.role === "direct_pdf" ? pdfInputVerificationStatus(result.evidence, configuration) === "verified"
          : result.status === "available" && hasVerifiedDedicatedProtocol(result.evidence, configuration);
        if (!valid) throw new Error("system_role_not_verified");
      } catch {
        throw new AdminSystemModelPolicyServiceError("system_model_policy_verification_failed");
      }
    },

    async update(input: Readonly<{
      imageProviderModelId?: string | null;
      imageParameters?: ImageGenerationParameters;
      chatTitleProviderModelId?: string | null;
      chatTitleReasoningEffort?: string | null;
      chatPdfNativeProviderModelId?: string | null;
      chatPdfNativeReasoningEffort?: string | null;
      chatPdfProviderModelId?: string | null;
      chatPdfReasoningEffort?: string | null;
      chatPdfProcessingMode?: "prefer_chat_model" | "use_pdf_reader" | "read_page_images";
      chatPdfFallbackMethod?: "pdf_reader" | "page_images";
      expectedVersion: number;
      /** Utility fields are present together for an explicit utility-role
       * save/clear; absent preserves that independent role. */
      providerModelId?: string | null;
      /** Absent preserves the independent reranker role. Present (including
       * null) is an explicit administrator save/clear and permanently closes
       * fresh-install default adoption for this installation. */
      rerankerProviderModelId?: string | null;
      reasoningEffort?: string | null;
      userId: string;
    }>): Promise<void> {
      const providerModelId = input.providerModelId;
      const reasoningEffort = input.reasoningEffort;
      const rerankerProviderModelId = input.rerankerProviderModelId;
      const hasImageUpdate = input.imageProviderModelId !== undefined;
      if (hasImageUpdate !== (input.imageParameters !== undefined) || input.imageProviderModelId === null && Object.keys(input.imageParameters ?? {}).length) {
        throw new AdminSystemModelPolicyServiceError("system_model_policy_image_parameters_invalid");
      }
      const hasTitleUpdate = input.chatTitleProviderModelId !== undefined;
      if (hasTitleUpdate !== (input.chatTitleReasoningEffort !== undefined)) {
        throw new Error("system_model_policy_update_invalid");
      }
      const hasPdfUpdate = input.chatPdfProviderModelId !== undefined;
      if (hasPdfUpdate !== (input.chatPdfReasoningEffort !== undefined)) {
        throw new Error("system_model_policy_update_invalid");
      }
      const hasPdfNativeUpdate = input.chatPdfNativeProviderModelId !== undefined;
      if (hasPdfNativeUpdate !== (input.chatPdfNativeReasoningEffort !== undefined)) {
        throw new Error("system_model_policy_update_invalid");
      }
      const hasPdfPolicyUpdate = input.chatPdfProcessingMode !== undefined || input.chatPdfFallbackMethod !== undefined;
      if (input.chatPdfProcessingMode !== undefined && !["prefer_chat_model", "use_pdf_reader", "read_page_images"].includes(input.chatPdfProcessingMode) ||
        input.chatPdfFallbackMethod !== undefined && !["pdf_reader", "page_images"].includes(input.chatPdfFallbackMethod)) {
        throw new Error("system_model_policy_update_invalid");
      }
      const hasUtilityUpdate = providerModelId !== undefined;
      const hasReasoningUpdate = reasoningEffort !== undefined;
      if (hasUtilityUpdate !== hasReasoningUpdate ||
        !hasUtilityUpdate && !hasTitleUpdate && !hasPdfUpdate && !hasPdfNativeUpdate && !hasPdfPolicyUpdate && !hasImageUpdate && rerankerProviderModelId === undefined) {
        throw new Error("system_model_policy_update_invalid");
      }
      try {
        await prisma.$transaction(async (tx) => {
          const policies = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
            SELECT "version"
            FROM "SystemModelPolicy"
            WHERE "id" = 'installation'
            FOR UPDATE
          `);
          if (!policies[0]) throw new Error("installation_system_model_policy_missing");
          if (policies[0].version !== input.expectedVersion) {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_stale");
          }

          const administrator = await tx.user.findFirst({
            select: { id: true },
            where: { id: input.userId, role: "admin", status: "active" }
          });
          if (!administrator) {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_target_unavailable"
            );
          }

          if (providerModelId === null && reasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_reasoning_unavailable"
            );
          }

          if (providerModelId !== undefined && providerModelId !== null) {
            try {
              const role = await loadRole(tx, {
                providerModelId
              });
              if (!systemModelRoleEligible(role, "memory")) {
                throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              }
              if (reasoningEffort !== undefined && reasoningEffort !== null &&
                !supportsReasoningEffort(role, reasoningEffort)) {
                throw new AdminSystemModelPolicyServiceError(
                  "system_model_policy_reasoning_unavailable"
                );
              }
            } catch (error) {
              if (error instanceof AdminSystemModelPolicyServiceError) throw error;
              if (error instanceof ProviderAdmissionError) {
                throw new AdminSystemModelPolicyServiceError(
                  "system_model_policy_target_unavailable"
                );
              }
              throw error;
            }
          }

          if (input.chatTitleProviderModelId === null && input.chatTitleReasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable");
          }
          if (input.chatTitleProviderModelId) {
            try {
              const role = await loadRole(tx, { providerModelId: input.chatTitleProviderModelId });
              if (!systemModelRoleEligible(role, "chat_titles")) {
                throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              }
              if (input.chatTitleReasoningEffort !== null && input.chatTitleReasoningEffort !== undefined &&
                !supportsReasoningEffort(role, input.chatTitleReasoningEffort)) {
                throw new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable");
              }
            } catch (error) {
              if (error instanceof ProviderAdmissionError) throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              throw error;
            }
          }
          if (input.chatPdfProviderModelId === null && input.chatPdfReasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable");
          }
          if (input.chatPdfProviderModelId) {
            try {
              const role = await loadRole(tx, { providerModelId: input.chatPdfProviderModelId });
              if (!systemModelRoleEligible(role, "vision") || input.chatPdfReasoningEffort &&
                !supportsReasoningEffort(role, input.chatPdfReasoningEffort)) {
                throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              }
            } catch (error) {
              if (error instanceof ProviderAdmissionError) throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              throw error;
            }
          }
          if (input.chatPdfNativeProviderModelId === null && input.chatPdfNativeReasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable");
          }
          if (input.chatPdfNativeProviderModelId) {
            try {
              const role = await loadRole(tx, { providerModelId: input.chatPdfNativeProviderModelId });
              if (!systemModelRoleEligible(role, "direct_pdf") || input.chatPdfNativeReasoningEffort &&
                !supportsReasoningEffort(role, input.chatPdfNativeReasoningEffort)) {
                throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              }
            } catch (error) {
              if (error instanceof ProviderAdmissionError) throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              throw error;
            }
          }
          if (rerankerProviderModelId !== undefined &&
            rerankerProviderModelId !== null) {
            try {
              await loadRerankerRole(tx, {
                providerModelId: rerankerProviderModelId
              });
            } catch (error) {
              if (error instanceof ProviderAdmissionError) {
                throw new AdminSystemModelPolicyServiceError(
                  "system_model_policy_target_unavailable"
                );
              }
              throw error;
            }
          }

          let imageParameters = input.imageParameters;
          if (input.imageProviderModelId) {
            try {
              const role = await loadInstallationImageProviderRole(tx, { providerModelId: input.imageProviderModelId });
              imageParameters = normalizeImageGenerationParameters(input.imageParameters, role.configuration.image!, role.configuration.upstreamModelId);
              normalizeImageGenerationParameters({ ...role.configuration.defaultParams, ...imageParameters },
                role.configuration.image!, role.configuration.upstreamModelId);
            } catch (error) {
              if (error instanceof ProviderAdmissionError) throw new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable");
              throw new AdminSystemModelPolicyServiceError("system_model_policy_image_parameters_invalid");
            }
          }
          await tx.systemModelPolicy.update({
            data: {
              ...(hasImageUpdate ? { imageProviderModelId: input.imageProviderModelId, imageParamsJson: imageParameters as Prisma.InputJsonObject } : {}),
              ...(hasTitleUpdate ? {
                chatTitleProviderModelId: input.chatTitleProviderModelId,
                chatTitleReasoningEffort: input.chatTitleReasoningEffort
              } : {}),
              ...(hasPdfUpdate ? {
                chatPdfProviderModelId: input.chatPdfProviderModelId,
                chatPdfReasoningEffort: input.chatPdfReasoningEffort
              } : {}),
              ...(hasPdfNativeUpdate ? {
                chatPdfNativeProviderModelId: input.chatPdfNativeProviderModelId,
                chatPdfNativeReasoningEffort: input.chatPdfNativeReasoningEffort
              } : {}),
              ...(hasPdfPolicyUpdate ? {
                ...(input.chatPdfProcessingMode !== undefined ? {
                  chatPdfProcessingMode: input.chatPdfProcessingMode === "prefer_chat_model"
                    ? "PREFER_CHAT_MODEL" as const
                    : input.chatPdfProcessingMode === "use_pdf_reader" ? "USE_PDF_READER" as const : "READ_PAGE_IMAGES" as const
                } : {}),
                ...(input.chatPdfFallbackMethod !== undefined ? {
                  chatPdfFallbackMethod: input.chatPdfFallbackMethod === "pdf_reader" ? "PDF_READER" as const : "PAGE_IMAGES" as const
                } : {})
              } : {}),
              ...(hasUtilityUpdate ? {
                providerModelId,
                reasoningEffort
              } : {}),
              // Utility and reranker are independent roles. Only a request
              // that explicitly carries the reranker field fixes that role;
              // a utility-only save must not suppress later default adoption.
              ...(rerankerProviderModelId !== undefined ? {
                rerankerConfiguredAt: new Date(),
                rerankerProviderModelId
              } : {}),
              updatedByUserId: input.userId,
              version: { increment: 1 }
            },
            where: { id: "installation" }
          });
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === "P2034") {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_stale");
          }
          if (error.code === "P2003") {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_target_unavailable"
            );
          }
        }
        throw error;
      }
    }
  };
}
