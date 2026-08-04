import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import { SearchConfigurationError } from "../../search/configuration";
import {
  AdminSearchServiceError,
  type createAdminSearchService
} from "./service";

type AdminSearchService = ReturnType<typeof createAdminSearchService>;

type SearchContext = {
  params: Promise<{ integrationId: string }> | { integrationId: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function body(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  if (!hasJsonContentType(request)) return [null, null];
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return { error: Response.json({ error: "unauthorized" }, { status: 401 }), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { error: Response.json({ error: "forbidden" }, { status: 403 }), session: null };
  }
  return { error: null, session };
}

function serviceError(error: AdminSearchServiceError): Response {
  const status = error.code === "search_integration_not_found"
    ? 404
    : error.code === "search_draft_stale" ||
        error.code === "search_policy_stale" ||
        error.code === "search_activation_evidence_missing" ||
        error.code === "search_integration_material_identity_changed" ||
        error.code === "search_source_not_ready"
      ? 409
      : error.code === "search_test_failed"
        ? 422
        : 400;
  return Response.json({ error: error.code }, { status });
}

async function safely(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminSearchServiceError) return serviceError(error);
    if (error instanceof SearchConfigurationError) {
      return Response.json({ error: error.code }, { status: 400 });
    }
    console.error("search_admin_action_failed");
    return Response.json({ error: "search_admin_action_failed" }, { status: 500 });
  }
}

async function catalog(service: AdminSearchService, userId: string, status = 200): Promise<Response> {
  return Response.json({ search: await service.list({ userId }) }, { status });
}

export function createAdminSearchCatalogHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminSearchService;
}>) {
  return {
    async GET(request: Request) {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      return safely(() => catalog(input.service, auth.session!.userId));
    },
    async POST(request: Request) {
      if (!hasJsonContentType(request)) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      const [value, bodyError] = await body(request);
      if (bodyError) return bodyError;
      if (!value || typeof value.displayName !== "string" ||
        typeof value.description !== "string" || !isRecord(value.draft)) {
        return Response.json({ error: "search_configuration_invalid" }, { status: 400 });
      }
      const displayName = value.displayName;
      const description = value.description;
      return safely(async () => {
        const selected = await input.service.createDraft({
          description,
          displayName,
          draft: value.draft
        });
        return Response.json({
          search: await input.service.list({ userId: auth.session!.userId }),
          selectedIntegrationId: selected.id
        }, { status: selected.created ? 201 : 200 });
      });
    },
    async PATCH(request: Request) {
      if (!hasJsonContentType(request)) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error || !auth.session) return auth.error!;
      const [value, bodyError] = await body(request);
      if (bodyError) return bodyError;
      if (!value || !Number.isSafeInteger(value.expectedVersion) ||
        !isRecord(value.defaultPlan)) {
        return Response.json({ error: "search_configuration_invalid" }, { status: 400 });
      }
      return safely(async () => {
        await input.service.updatePolicy({
          defaultPlan: value.defaultPlan,
          expectedVersion: Number(value.expectedVersion),
          userId: auth.session!.userId
        });
        return catalog(input.service, auth.session!.userId);
      });
    }
  };
}

export function createAdminSearchIntegrationHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminSearchService;
}>) {
  return async function PATCH(request: Request, context: SearchContext): Promise<Response> {
    if (!hasJsonContentType(request)) {
      return Response.json({ error: "json_required" }, { status: 415 });
    }
    const auth = await requireAdmin(request, input.resolveAuth);
    if (auth.error || !auth.session) return auth.error!;
    const [value, bodyError] = await body(request);
    if (bodyError) return bodyError;
    if (!value || typeof value.displayName !== "string" ||
      typeof value.description !== "string" || !isRecord(value.draft) ||
      !Number.isSafeInteger(value.expectedDraftVersion)) {
      return Response.json({ error: "search_configuration_invalid" }, { status: 400 });
    }
    const { integrationId } = await context.params;
    const displayName = value.displayName;
    const description = value.description;
    return safely(async () => {
      await input.service.updateDraft({
        description,
        displayName,
        draft: value.draft,
        expectedDraftVersion: Number(value.expectedDraftVersion),
        id: integrationId
      });
      return catalog(input.service, auth.session.userId);
    });
  };
}

export function createAdminSearchActionHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminSearchService;
}>) {
  return async function POST(request: Request, context: SearchContext): Promise<Response> {
    if (!hasJsonContentType(request)) {
      return Response.json({ error: "json_required" }, { status: 415 });
    }
    const auth = await requireAdmin(request, input.resolveAuth);
    if (auth.error || !auth.session) return auth.error!;
    const [value, bodyError] = await body(request);
    if (bodyError) return bodyError;
    const action = value?.action;
    const { integrationId } = await context.params;
    return safely(async () => {
      if (action === "test") {
        await input.service.testDraft({ id: integrationId, userId: auth.session!.userId });
      } else if (action === "activate") {
        await input.service.activate({ id: integrationId, userId: auth.session!.userId });
      } else if (action === "enable") {
        await input.service.setEnabled({
          enabled: true,
          id: integrationId,
          userId: auth.session!.userId
        });
      } else if (action === "disable") {
        await input.service.setEnabled({
          enabled: false,
          id: integrationId,
          userId: auth.session!.userId
        });
      } else if (action === "archive") {
        if (value?.confirmed !== true) {
          return Response.json({ error: "search_archive_confirmation_required" }, { status: 409 });
        }
        await input.service.archive({ id: integrationId });
      } else {
        return Response.json({ error: "search_action_invalid" }, { status: 400 });
      }
      return catalog(input.service, auth.session!.userId);
    });
  };
}
