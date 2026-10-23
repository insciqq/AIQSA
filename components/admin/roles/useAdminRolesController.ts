import type { ImageGenerationParameters } from "@/lib/contracts/imageGeneration";
import type { DecisionFeatureOverrides } from "@/lib/contracts/semanticDecisions";
import {
  adminModelPolicyErrorMessage,
  getAdminModelPolicy,
  updateAdminModelPolicy,
  type AdminModelPolicyUpdateInput
} from "@/components/admin/adminModelPolicyApi";
import {
  adminSystemModelPolicyErrorMessage,
  getAdminSystemModelPolicy,
  updateAdminSystemModelPolicy,
  verifyAdminSystemModelRole
} from "@/components/admin/adminSystemModelPolicyApi";
import type { AdminFeedbackNoticeAction } from "@/components/admin/useAdminFeedback";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import { initialChatTitleReasoningEffort } from "@/lib/contracts/adminSystemModelPolicy";
import type {
  AdminSystemModelEligibilityRole,
  AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Fields of one immediate role save; absent fields preserve the other roles. */
export type AdminRolePatch = Readonly<{
  memoryProviderModelId?: string | null;
  memoryReasoningEffort?: string | null;
  memoryRecommendationId?: string;
  /** The image default, always sent with the complete published set. */
  imageProviderModelId?: string | null;
  imageModels?: ReadonlyArray<Readonly<{ providerModelId: string; parameters: ImageGenerationParameters }>>;
  chatTitleProviderModelId?: string | null;
  chatTitleReasoningEffort?: string | null;
  chatPdfNativeProviderModelId?: string | null;
  chatPdfNativeReasoningEffort?: string | null;
  visionProviderModelId?: string | null;
  visionReasoningEffort?: string | null;
  chatPdfProviderModelId?: string | null;
  chatPdfReasoningEffort?: string | null;
  chatPdfProcessingMode?: "prefer_chat_model" | "use_pdf_reader" | "read_page_images";
  chatPdfFallbackMethod?: "pdf_reader" | "page_images";
  providerModelId?: string | null;
  reasoningEffort?: string | null;
  rerankerProviderModelId?: string | null;
  decisionProviderModelId?: string | null;
  decisionFeatures?: DecisionFeatureOverrides;
}>;

export type AdminRolesController = Readonly<{
  /** Immediate apply for independent roles; `undo` reverts through the same PATCH. */
  assign(patch: AdminRolePatch, undo: AdminRolePatch | null): Promise<boolean>;
  busy: boolean;
  checkAndAssign(role: "chat_titles" | "memory" | "system" | "vision" | "pdf_images" | "direct_pdf", id: string): Promise<boolean>;
  checking: Readonly<{ id: string; role: AdminSystemModelEligibilityRole }> | null;
  error: string | null;
  loading: boolean;
  modelPolicy: AdminModelPolicyCatalog | null;
  modelPolicyError: string | null;
  policy: AdminSystemModelPolicyCatalog | null;
  refresh(): Promise<void>;
  saveChatDefaults(input: Omit<AdminModelPolicyUpdateInput, "expectedVersion">): Promise<string | null>;
}>;

export type UseAdminRolesControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
  reportError(message: string): void;
  reportNotice(message: string, action?: AdminFeedbackNoticeAction): void;
}>;

export const ADMIN_ROLE_SAVED_NOTICE = "Saved for future work";

/**
 * One state owner for the Defaults & roles page: the role catalog and the
 * chat defaults policy, plus every mutation. Server
 * responses replace local state after each save; nothing is pre-selected
 * that the server did not report.
 */
export function useAdminRolesController({
  onMutationCommitted,
  reportError,
  reportNotice
}: UseAdminRolesControllerOptions): AdminRolesController {
  const [policy, setPolicyState] = useState<AdminSystemModelPolicyCatalog | null>(null);
  const [modelPolicy, setModelPolicyState] = useState<AdminModelPolicyCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelPolicyError, setModelPolicyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<AdminRolesController["checking"]>(null);
  const policyRef = useRef<AdminSystemModelPolicyCatalog | null>(null);
  const modelPolicyRef = useRef<AdminModelPolicyCatalog | null>(null);
  const assignRef = useRef<AdminRolesController["assign"] | null>(null);
  const readEpoch = useRef(0);
  const readSequence = useRef({ model: 0, policy: 0 });
  const actionPending = useRef(false);
  const invalidateReads = useCallback(() => {
    readEpoch.current += 1;
    setLoading(false);
  }, []);
  const setMutationBusy = useCallback((pending: boolean) => {
    invalidateReads();
    actionPending.current = pending;
    setBusy(pending);
  }, [invalidateReads]);

  const setPolicy = useCallback((next: AdminSystemModelPolicyCatalog) => {
    policyRef.current = next;
    setPolicyState(next);
  }, []);
  const setModelPolicy = useCallback((next: AdminModelPolicyCatalog) => {
    modelPolicyRef.current = next;
    setModelPolicyState(next);
  }, []);
  const commit = useCallback(() => {
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  }, [onMutationCommitted]);

  const refreshPolicy = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    const sequence = ++readSequence.current.policy;
    const result = await getAdminSystemModelPolicy();
    if (epoch !== readEpoch.current || sequence !== readSequence.current.policy) return;
    if (result.ok) {
      setPolicy(result.data);
      setError(null);
    } else {
      setError(adminSystemModelPolicyErrorMessage(result.error));
    }
  }, [setPolicy]);
  const refreshModelPolicy = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    const sequence = ++readSequence.current.model;
    const result = await getAdminModelPolicy();
    if (epoch !== readEpoch.current || sequence !== readSequence.current.model) return;
    if (result.ok) {
      setModelPolicy(result.data);
      setModelPolicyError(null);
    } else {
      setModelPolicyError(adminModelPolicyErrorMessage(result.error));
    }
  }, [setModelPolicy]);
  const refresh = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    setLoading(true);
    await Promise.all([refreshPolicy(), refreshModelPolicy()]);
    if (epoch === readEpoch.current) setLoading(false);
  }, [refreshModelPolicy, refreshPolicy]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      disposed = true;
      readEpoch.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  const assign = useCallback(async (patch: AdminRolePatch, undo: AdminRolePatch | null): Promise<boolean> => {
    const current = policyRef.current;
    if (!current) return false;
    setMutationBusy(true);
    const result = await updateAdminSystemModelPolicy({
      ...(Object.hasOwn(patch, "memoryProviderModelId")
        ? { expectedMemoryVersion: current.memoryPolicy.version }
        : { expectedVersion: current.policy.version }),
      ...patch
    });
    setMutationBusy(false);
    if (!result.ok) {
      reportError(adminSystemModelPolicyErrorMessage(result.error));
      if (result.error === "system_model_policy_stale") void refreshPolicy();
      return false;
    }
    setPolicy(result.data);
    if (undo) {
      reportNotice(ADMIN_ROLE_SAVED_NOTICE, {
        label: "Undo",
        onSelect: () => {
          void assignRef.current?.(undo, null);
        }
      });
    } else {
      reportNotice("Previous assignment restored for future work");
    }
    commit();
    return true;
  }, [commit, refreshPolicy, reportError, reportNotice, setMutationBusy, setPolicy]);
  useEffect(() => {
    assignRef.current = assign;
  }, [assign]);

  const check = useCallback(async (role: AdminSystemModelEligibilityRole, id: string): Promise<boolean> => {
    invalidateReads();
    actionPending.current = true;
    setChecking({ id, role });
    const result = await verifyAdminSystemModelRole(id, role);
    invalidateReads();
    actionPending.current = false;
    setChecking(null);
    if (!result.ok) {
      reportError(adminSystemModelPolicyErrorMessage(result.error));
      return false;
    }
    setPolicy(result.data);
    return true;
  }, [invalidateReads, reportError, setPolicy]);

  const checkAndAssign = useCallback(async (role: "chat_titles" | "memory" | "system" | "vision" | "pdf_images" | "direct_pdf", id: string): Promise<boolean> => {
    const previous = policyRef.current?.policy;
    const previousMemory = policyRef.current?.memoryPolicy;
    if (!previous || !previousMemory || !await check(role === "system" ? "memory" : role === "pdf_images" ? "vision" : role, id)) return false;
    if (role === "vision" && previous.version !== policyRef.current?.policy.version) {
      reportError(adminSystemModelPolicyErrorMessage("system_model_policy_stale"));
      return false;
    }
    if (role === "memory") return assign(
      { memoryProviderModelId: id, memoryReasoningEffort: null },
      { memoryProviderModelId: previousMemory.model?.id ?? null, memoryReasoningEffort: previousMemory.reasoningEffort }
    );
    if (role === "chat_titles") return assign(
      { chatTitleProviderModelId: id, chatTitleReasoningEffort: initialChatTitleReasoningEffort(
        policyRef.current?.titleCandidates.find((candidate) => candidate.id === id)
      ) },
      { chatTitleProviderModelId: previous.chatTitleModel?.id ?? null, chatTitleReasoningEffort: previous.chatTitleReasoningEffort }
    );
    if (role === "vision") return assign(
      { visionProviderModelId: id, visionReasoningEffort: null },
      { visionProviderModelId: previous.visionModel?.id ?? null, visionReasoningEffort: previous.visionReasoningEffort ?? null }
    );
    if (role === "direct_pdf") return assign(
      { chatPdfNativeProviderModelId: id, chatPdfNativeReasoningEffort: null },
      { chatPdfNativeProviderModelId: previous.chatPdfNativeModel?.id ?? null,
        chatPdfNativeReasoningEffort: previous.chatPdfNativeReasoningEffort ?? null }
    );
    return role === "system"
      ? assign(
          { providerModelId: id, reasoningEffort: null },
          { providerModelId: previous.systemModel?.id ?? null, reasoningEffort: previous.reasoningEffort }
        )
      : assign(
          { chatPdfProviderModelId: id, chatPdfReasoningEffort: null },
          {
            chatPdfProviderModelId: previous.chatPdfModel?.id ?? null,
            chatPdfReasoningEffort: previous.chatPdfReasoningEffort
          }
        );
  }, [assign, check, reportError]);

  const saveChatDefaults = useCallback(async (
    input: Omit<AdminModelPolicyUpdateInput, "expectedVersion">
  ): Promise<string | null> => {
    const current = modelPolicyRef.current;
    if (!current) return "Chat defaults are still loading.";
    setMutationBusy(true);
    const result = await updateAdminModelPolicy({ expectedVersion: current.policy.version, ...input });
    setMutationBusy(false);
    if (!result.ok) {
      if (result.error === "model_policy_stale") void refreshModelPolicy();
      return adminModelPolicyErrorMessage(result.error);
    }
    setModelPolicy(result.data);
    reportNotice("Chat defaults saved for new chats");
    commit();
    return null;
  }, [commit, refreshModelPolicy, reportNotice, setModelPolicy, setMutationBusy]);

  return useMemo(() => ({
    assign,
    busy,
    checkAndAssign,
    checking,
    error,
    loading,
    modelPolicy,
    modelPolicyError,
    policy,
    refresh,
    saveChatDefaults
  }), [
    assign, busy, checkAndAssign, checking, error, loading, modelPolicy, modelPolicyError, policy, refresh,
    saveChatDefaults
  ]);
}
