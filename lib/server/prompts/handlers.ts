import type { RequestAuthResolver } from "../auth/requestAuth";

export type PromptPresetRecord = {
  developerPrompt: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  systemPrompt: string;
};

export type PromptRepository = {
  createPrompt(input: {
    developerPrompt?: string | null;
    name: string;
    systemPrompt: string;
    userId: string;
  }): Promise<PromptPresetRecord | null>;
  deletePrompt(input: { promptId: string; userId: string }): Promise<"deleted" | "default" | "not_found">;
  setDefaultPrompt(input: { promptId: string; userId: string }): Promise<PromptPresetRecord | null>;
  updatePrompt(input: {
    developerPrompt?: string | null;
    name?: string | null;
    promptId: string;
    systemPrompt?: string | null;
    userId: string;
  }): Promise<PromptPresetRecord | null>;
};

export type PromptHandlerDeps = {
  repository: PromptRepository;
  resolveAuth: RequestAuthResolver;
};

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalTextValue(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function auth(request: Request, deps: PromptHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) {
    return {
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
      session: null
    };
  }

  return {
    response: null,
    session
  };
}

export function createCreatePromptHandler(deps: PromptHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const body = await readJson(request);
    const name = textValue(body?.name);
    const systemPrompt = textValue(body?.systemPrompt);
    if (!name || !systemPrompt) {
      return Response.json({ error: "prompt_name_and_system_required" }, { status: 400 });
    }

    const prompt = await deps.repository.createPrompt({
      developerPrompt: optionalTextValue(body?.developerPrompt) ?? null,
      name,
      systemPrompt,
      userId: result.session.userId
    });

    if (!prompt) {
      return Response.json({ error: "prompt_not_created" }, { status: 400 });
    }

    return Response.json({ prompt }, { status: 201 });
  };
}

export function createUpdatePromptHandler(deps: PromptHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ promptId: string }> | { promptId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const body = await readJson(request);
    const prompt = await deps.repository.updatePrompt({
      developerPrompt: optionalTextValue(body?.developerPrompt),
      name: optionalTextValue(body?.name),
      promptId: params.promptId,
      systemPrompt: optionalTextValue(body?.systemPrompt),
      userId: result.session.userId
    });

    if (!prompt) {
      return Response.json({ error: "prompt_not_found_or_duplicate" }, { status: 404 });
    }

    return Response.json({ prompt });
  };
}

export function createDeletePromptHandler(deps: PromptHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ promptId: string }> | { promptId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const deleted = await deps.repository.deletePrompt({
      promptId: params.promptId,
      userId: result.session.userId
    });

    if (deleted === "default") {
      return Response.json({ error: "default_prompt_not_deletable" }, { status: 409 });
    }

    if (deleted === "not_found") {
      return Response.json({ error: "prompt_not_found" }, { status: 404 });
    }

    return Response.json({
      prompt: {
        deleted: true,
        id: params.promptId
      }
    });
  };
}

export function createSetDefaultPromptHandler(deps: PromptHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ promptId: string }> | { promptId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const prompt = await deps.repository.setDefaultPrompt({
      promptId: params.promptId,
      userId: result.session.userId
    });

    if (!prompt) {
      return Response.json({ error: "prompt_not_found" }, { status: 404 });
    }

    return Response.json({
      defaultPromptPresetId: prompt.id,
      prompt
    });
  };
}
