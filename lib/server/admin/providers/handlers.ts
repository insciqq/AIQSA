import type {
  AdminProviderConnectionConfiguration,
  AdminProviderFamily,
  AdminProviderModelConfiguration,
  AdminProviderUnassignedPolicy
} from "../../../contracts/adminProviders";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import { ProviderConfigurationError } from "../../providers/providerConfiguration";
import {
  AdminProviderServiceError,
  type AdminProviderService
} from "./service";

export type AdminProviderHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminProviderService;
}>;

type ConnectionContext = {
  params: Promise<{ connectionId: string }> | { connectionId: string };
};

type CredentialContext = {
  params:
    | Promise<{ connectionId: string; credentialId: string }>
    | { connectionId: string; credentialId: string };
};

type ModelContext = {
  params:
    | Promise<{ connectionId: string; modelId: string }>
    | { connectionId: string; modelId: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength = 2_048): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function version(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647
    ? Number(value)
    : null;
}

function family(value: unknown): AdminProviderFamily | null {
  return value === "anthropic" || value === "gemini" || value === "openai" ||
    value === "openai_compatible" || value === "openrouter"
    ? value
    : null;
}

function policy(value: unknown): AdminProviderUnassignedPolicy | null {
  return value === "require_assignment" || value === "use_default" ? value : null;
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function readBody(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  if (!hasJsonContentType(request)) return [null, null];
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function errorJson(error: string, status: number, details?: Record<string, unknown>): Response {
  return Response.json({ error, ...details }, { status });
}

async function requireAdmin(request: Request, deps: AdminProviderHandlerDeps): Promise<Response | null> {
  const session = await deps.resolveAuth(request);
  if (!session) return errorJson("unauthorized", 401);
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return errorJson("forbidden", 403);
  }
  return null;
}

function serviceError(error: AdminProviderServiceError): Response {
  const notFound = new Set([
    "provider_active_tuple_not_found",
    "provider_connection_not_found",
    "provider_credential_not_found",
    "provider_group_not_found",
    "provider_model_not_found"
  ]);
  const conflict = new Set([
    "provider_activation_empty",
    "provider_activation_evidence_missing",
    "provider_activation_unavailable_confirmation_required",
    "provider_delete_confirmation_required",
    "provider_draft_stale",
    "provider_model_class_immutable",
    "provider_revoke_confirmation_required"
  ]);
  const status = notFound.has(error.code)
    ? 404
    : conflict.has(error.code)
      ? 409
      : error.code === "provider_discovery_failed"
        ? 502
        : error.code === "provider_refresh_failed"
          ? 502
        : error.code === "provider_draft_test_failed" ||
          error.code === "provider_credential_test_failed"
          ? 422
          : 400;
  return errorJson(error.code, status, error.resourceIds.length
    ? { resourceIds: error.resourceIds }
    : undefined);
}

async function safely(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminProviderServiceError) return serviceError(error);
    if (error instanceof ProviderConfigurationError ||
      (error instanceof Error && error.message === "provider_credential_secret_invalid")) {
      return errorJson("provider_configuration_invalid", 400);
    }
    console.error("provider_admin_action_failed");
    return errorJson("provider_admin_action_failed", 500);
  }
}

async function catalog(service: AdminProviderService, status = 200): Promise<Response> {
  return Response.json({ connections: await service.listConnections() }, { status });
}

async function connectionExists(service: AdminProviderService, connectionId: string): Promise<boolean> {
  return (await service.listConnections()).some((connection) => connection.id === connectionId);
}

async function credentialBelongs(
  service: AdminProviderService,
  connectionId: string,
  credentialId: string
): Promise<boolean> {
  return (await service.listConnections()).some((connection) =>
    connection.id === connectionId && connection.credentials.some(({ id }) => id === credentialId)
  );
}

async function modelBelongs(
  service: AdminProviderService,
  connectionId: string,
  modelId: string
): Promise<boolean> {
  return (await service.listConnections()).some((connection) =>
    connection.id === connectionId && connection.models.some(({ id }) => id === modelId)
  );
}

export function createAdminProviderCatalogHandler(deps: AdminProviderHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    return safely(() => catalog(deps.service));
  };
}

export function createAdminProviderConnectionCreateHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const displayName = text(body?.displayName, 160);
    const providerFamily = family(body?.family);
    const unassignedPolicy = body?.unassignedPolicy === undefined
      ? "use_default"
      : policy(body.unassignedPolicy);
    if (!body || !displayName || !providerFamily || !unassignedPolicy || !isRecord(body.configuration)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    return safely(async () => {
      await deps.service.createConnectionDraft({
        configuration: body.configuration as AdminProviderConnectionConfiguration,
        displayName,
        family: providerFamily,
        unassignedPolicy
      });
      return catalog(deps.service, 201);
    });
  };
}

export function createAdminProviderConnectionUpdateHandler(deps: AdminProviderHandlerDeps) {
  return async function PATCH(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const displayName = text(body?.displayName, 160);
    const expectedDraftVersion = version(body?.expectedDraftVersion);
    const unassignedPolicy = policy(body?.unassignedPolicy);
    if (!body || !displayName || expectedDraftVersion === null || !unassignedPolicy ||
      !isRecord(body.configuration)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const { connectionId } = await context.params;
    return safely(async () => {
      await deps.service.updateConnectionDraft({
        configuration: body.configuration as AdminProviderConnectionConfiguration,
        connectionId,
        displayName,
        expectedDraftVersion,
        unassignedPolicy
      });
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderConnectionDeleteHandler(deps: AdminProviderHandlerDeps) {
  return async function DELETE(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    if (body?.confirmed !== true) return errorJson("provider_delete_confirmation_required", 409);
    const { connectionId } = await context.params;
    return safely(async () => {
      const result = await deps.service.deleteConnection({ confirmed: true, connectionId });
      if (result.status === "not_found") return errorJson("provider_connection_not_found", 404);
      if (result.status === "conflict") {
        return errorJson("provider_delete_conflict", 409, { blockers: result.blockers });
      }
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderConnectionActionHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const action = text(body?.action, 64);
    if (!body || !action) return errorJson("provider_action_invalid", 400);
    const { connectionId } = await context.params;

    return safely(async () => {
      if (action === "activate") {
        if (typeof body.confirmUnavailable !== "boolean" ||
          typeof body.enableConnection !== "boolean") {
          return errorJson("provider_action_invalid", 400);
        }
        await deps.service.activateConnection({
          confirmUnavailable: body.confirmUnavailable,
          connectionId,
          enableConnection: body.enableConnection,
          signal: request.signal
        });
        return catalog(deps.service);
      }
      if (action === "enable" || action === "disable") {
        if (!await connectionExists(deps.service, connectionId)) {
          return errorJson("provider_connection_not_found", 404);
        }
        await deps.service[action]("connection", connectionId);
        return catalog(deps.service);
      }
      if (action === "set_default_credential") {
        const credentialId = body.credentialId === null ? null : text(body.credentialId, 128);
        if (body.credentialId !== null && !credentialId) {
          return errorJson("provider_action_invalid", 400);
        }
        await deps.service.setDefaultCredential({ connectionId, credentialId });
        return catalog(deps.service);
      }
      if (action === "assign_group_credential") {
        const credentialId = text(body.credentialId, 128);
        const groupId = text(body.groupId, 128);
        if (!credentialId || !groupId) return errorJson("provider_action_invalid", 400);
        await deps.service.assignGroupCredential({ connectionId, credentialId, groupId });
        return catalog(deps.service);
      }
      if (action === "revoke_group_credential") {
        const groupId = text(body.groupId, 128);
        if (!groupId) return errorJson("provider_action_invalid", 400);
        await deps.service.revokeGroupCredential({ connectionId, groupId });
        return catalog(deps.service);
      }
      if (action === "discover_models") {
        const credentialId = text(body.credentialId, 128);
        if (!credentialId) return errorJson("provider_action_invalid", 400);
        const models = await deps.service.discoverOpenRouterModels({
          connectionId,
          credentialId,
          signal: request.signal
        });
        return Response.json({ models });
      }
      if (action === "discover_compatible_models") {
        const credentialId = text(body.credentialId, 128);
        if (!credentialId) return errorJson("provider_action_invalid", 400);
        const models = await deps.service.discoverCompatibleModels({
          connectionId,
          credentialId,
          signal: request.signal
        });
        return Response.json({ models });
      }
      if (action === "discover_endpoints") {
        const credentialId = text(body.credentialId, 128);
        const modelId = text(body.modelId, 256);
        if (!credentialId || !modelId) return errorJson("provider_action_invalid", 400);
        const endpoints = await deps.service.discoverOpenRouterEndpoints({
          connectionId,
          credentialId,
          modelId,
          signal: request.signal
        });
        return Response.json({ endpoints });
      }
      if (action === "refresh_active") {
        const credentialId = text(body.credentialId, 128);
        const providerModelId = text(body.providerModelId, 128);
        if (!credentialId || !providerModelId ||
          (body.confirmPaidRequest !== undefined && typeof body.confirmPaidRequest !== "boolean")) {
          return errorJson("provider_action_invalid", 400);
        }
        await deps.service.refreshActive({
          confirmPaidRequest: body.confirmPaidRequest === true,
          connectionId,
          credentialId,
          providerModelId,
          signal: request.signal
        });
        return catalog(deps.service);
      }
      return errorJson("provider_action_invalid", 400);
    });
  };
}

export function createAdminProviderCredentialCreateHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const label = text(body?.label, 160);
    const secret = text(body?.secret, 16_384);
    if (!body || !label || !secret) return errorJson("provider_configuration_invalid", 400);
    const { connectionId } = await context.params;
    return safely(async () => {
      await deps.service.createCredentialDraft({ connectionId, label, secret });
      return catalog(deps.service, 201);
    });
  };
}

export function createAdminProviderCredentialTestHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const expectedConnectionDraftVersion = version(body?.expectedConnectionDraftVersion);
    const secret = text(body?.secret, 16_384);
    if (!body || expectedConnectionDraftVersion === null || !secret) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const { connectionId } = await context.params;
    return safely(async () => {
      const test = await deps.service.testCredential({
        connectionId,
        expectedConnectionDraftVersion,
        secret,
        signal: request.signal
      });
      return Response.json({ test });
    });
  };
}

export function createAdminProviderCredentialUpdateHandler(deps: AdminProviderHandlerDeps) {
  return async function PATCH(request: Request, context: CredentialContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const action = text(body?.action, 64);
    if (!body || !action) return errorJson("provider_action_invalid", 400);
    const { connectionId, credentialId } = await context.params;
    return safely(async () => {
      if (!await credentialBelongs(deps.service, connectionId, credentialId)) {
        return errorJson("provider_credential_not_found", 404);
      }
      if (action === "rename") {
        const label = text(body.label, 160);
        if (!label) return errorJson("provider_configuration_invalid", 400);
        await deps.service.renameCredential({ credentialId, label });
      } else if (action === "rotate") {
        const expectedDraftVersion = version(body.expectedDraftVersion);
        const secret = text(body.secret, 16_384);
        if (expectedDraftVersion === null || !secret) {
          return errorJson("provider_configuration_invalid", 400);
        }
        await deps.service.rotateCredential({ credentialId, expectedDraftVersion, secret });
      } else if (action === "clear_draft") {
        const expectedDraftVersion = version(body.expectedDraftVersion);
        if (expectedDraftVersion === null || body.confirmed !== true) {
          return errorJson("provider_revoke_confirmation_required", 409);
        }
        await deps.service.clearCredentialDraft({
          confirmed: true,
          credentialId,
          expectedDraftVersion
        });
      } else if (action === "enable" || action === "disable") {
        await deps.service[action]("credential", credentialId);
      } else if (action === "revoke_active_version") {
        const versionId = text(body.versionId, 128);
        if (!versionId || body.confirmed !== true || typeof body.clearSecret !== "boolean") {
          return errorJson("provider_revoke_confirmation_required", 409);
        }
        await deps.service.revokeCredentialVersion({
          clearSecret: body.clearSecret,
          confirmed: true,
          credentialId,
          versionId
        });
      } else {
        return errorJson("provider_action_invalid", 400);
      }
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderCredentialDeleteHandler(deps: AdminProviderHandlerDeps) {
  return async function DELETE(request: Request, context: CredentialContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    if (body?.confirmed !== true) return errorJson("provider_delete_confirmation_required", 409);
    const { connectionId, credentialId } = await context.params;
    return safely(async () => {
      if (!await credentialBelongs(deps.service, connectionId, credentialId)) {
        return errorJson("provider_credential_not_found", 404);
      }
      const result = await deps.service.deleteCredential({ confirmed: true, credentialId });
      if (result.status === "conflict") {
        return errorJson("provider_delete_conflict", 409, { blockers: result.blockers });
      }
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderModelCreateHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request, context: ConnectionContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const displayName = text(body?.displayName, 160);
    if (!body || !displayName || !isRecord(body.configuration)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const { connectionId } = await context.params;
    return safely(async () => {
      await deps.service.createModelDraft({
        availableInProjects: body.availableInProjects === true,
        configuration: body.configuration as AdminProviderModelConfiguration,
        connectionId,
        displayName
      });
      return catalog(deps.service, 201);
    });
  };
}

export function createAdminProviderModelUpdateHandler(deps: AdminProviderHandlerDeps) {
  return async function PATCH(request: Request, context: ModelContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const action = text(body?.action, 64);
    if (!body || !action) return errorJson("provider_action_invalid", 400);
    const { connectionId, modelId } = await context.params;
    return safely(async () => {
      if (!await modelBelongs(deps.service, connectionId, modelId)) {
        return errorJson("provider_model_not_found", 404);
      }
      if (action === "update") {
        const displayName = text(body.displayName, 160);
        const expectedDraftVersion = version(body.expectedDraftVersion);
        if (!displayName || expectedDraftVersion === null || !isRecord(body.configuration)) {
          return errorJson("provider_configuration_invalid", 400);
        }
        await deps.service.updateModelDraft({
          ...(typeof body.availableInProjects === "boolean"
            ? { availableInProjects: body.availableInProjects }
            : {}),
          configuration: body.configuration as AdminProviderModelConfiguration,
          displayName,
          expectedDraftVersion,
          modelId
        });
      } else if (action === "enable" || action === "disable") {
        await deps.service[action]("model", modelId);
      } else {
        return errorJson("provider_action_invalid", 400);
      }
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderModelDeleteHandler(deps: AdminProviderHandlerDeps) {
  return async function DELETE(request: Request, context: ModelContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    if (body?.confirmed !== true) return errorJson("provider_delete_confirmation_required", 409);
    const { connectionId, modelId } = await context.params;
    return safely(async () => {
      if (!await modelBelongs(deps.service, connectionId, modelId)) {
        return errorJson("provider_model_not_found", 404);
      }
      const result = await deps.service.deleteModel({ confirmed: true, modelId });
      if (result.status === "conflict") {
        return errorJson("provider_delete_conflict", 409, { blockers: result.blockers });
      }
      return catalog(deps.service);
    });
  };
}

export function createAdminProviderDraftTestHandler(deps: AdminProviderHandlerDeps) {
  return async function POST(request: Request, context: ModelContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const authError = await requireAdmin(request, deps);
    if (authError) return authError;
    const [body, bodyError] = await readBody(request);
    if (bodyError) return bodyError;
    const credentialId = text(body?.credentialId, 128);
    const mode = body?.mode === "account_catalog" || body?.mode === "tiny_generation"
      ? body.mode
      : null;
    if (!body || !credentialId || !mode ||
      (body.confirmPaidRequest !== undefined && typeof body.confirmPaidRequest !== "boolean")) {
      return errorJson("provider_action_invalid", 400);
    }
    const { connectionId, modelId } = await context.params;
    return safely(async () => {
      if (!await modelBelongs(deps.service, connectionId, modelId) ||
        !await credentialBelongs(deps.service, connectionId, credentialId)) {
        return errorJson("provider_model_not_found", 404);
      }
      const check = await deps.service.testDraft({
        confirmPaidRequest: body.confirmPaidRequest === true,
        connectionId,
        credentialId,
        mode,
        providerModelId: modelId,
        signal: request.signal
      });
      return Response.json({ check });
    });
  };
}
