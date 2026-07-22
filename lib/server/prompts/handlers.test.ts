import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createCreatePromptHandler,
  createDeletePromptHandler,
  createSetDefaultPromptHandler,
  createUpdatePromptHandler,
  type PromptRepository
} from "./handlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authCookie() {
  return auth.cookie;
}

function createMemoryRepository(): {
  defaultPrompt: {
    id: string | null;
  };
  prompts: Map<string, {
    developerPrompt: string | null;
    id: string;
    isDefault: boolean;
    name: string;
    systemPrompt: string;
    userId: string;
  }>;
  repository: PromptRepository;
} {
  const defaultPrompt = {
    id: "prompt-default" as string | null
  };
  const prompts = new Map<string, {
    developerPrompt: string | null;
    id: string;
    isDefault: boolean;
    name: string;
    systemPrompt: string;
    userId: string;
  }>();
  prompts.set("prompt-default", {
    developerPrompt: null,
    id: "prompt-default",
    isDefault: true,
    name: "Helpful Assistant",
    systemPrompt: "You are helpful.",
    userId: config.bootstrapUserId
  });

  const repository: PromptRepository = {
    createPrompt: async (input) => {
      const id = `prompt-${prompts.size + 1}`;
      const prompt = {
        developerPrompt: input.developerPrompt ?? null,
        id,
        isDefault: false,
        name: input.name,
        systemPrompt: input.systemPrompt,
        userId: input.userId
      };
      prompts.set(id, prompt);
      return prompt;
    },
    deletePrompt: async ({ promptId, userId }) => {
      const prompt = prompts.get(promptId);
      if (!prompt || prompt.userId !== userId) {
        return "not_found";
      }

      if (prompt.isDefault) {
        return "default";
      }

      prompts.delete(promptId);
      return "deleted";
    },
    setDefaultPrompt: async ({ promptId, userId }) => {
      const prompt = prompts.get(promptId);
      if (!prompt || prompt.userId !== userId) {
        return null;
      }

      for (const [id, candidate] of prompts) {
        if (candidate.userId === userId) {
          prompts.set(id, {
            ...candidate,
            isDefault: false
          });
        }
      }

      const updated = {
        ...prompt,
        isDefault: true
      };
      prompts.set(prompt.id, updated);
      defaultPrompt.id = prompt.id;
      return updated;
    },
    updatePrompt: async ({ developerPrompt, name, promptId, systemPrompt, userId }) => {
      const prompt = prompts.get(promptId);
      if (!prompt || prompt.userId !== userId) {
        return null;
      }

      const updated = {
        ...prompt,
        developerPrompt: developerPrompt === undefined ? prompt.developerPrompt : developerPrompt,
        name: name ?? prompt.name,
        systemPrompt: systemPrompt ?? prompt.systemPrompt
      };
      prompts.set(promptId, updated);
      return updated;
    }
  };

  return { defaultPrompt, prompts, repository };
}

describe("prompt route handlers", () => {
  it("creates a prompt preset for the authenticated user", async () => {
    const { repository } = createMemoryRepository();
    const POST = createCreatePromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/prompts", {
        body: JSON.stringify({
          developerPrompt: "Developer guardrail",
          name: "Research",
          systemPrompt: "Research carefully."
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      prompt: {
        developerPrompt: "Developer guardrail",
        isDefault: false,
        name: "Research",
        systemPrompt: "Research carefully."
      }
    });
  });

  it("updates an owned prompt preset", async () => {
    const { repository } = createMemoryRepository();
    const PATCH = createUpdatePromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/prompts/prompt-default", {
        body: JSON.stringify({
          name: "Helpful Assistant v2",
          systemPrompt: "Be concise."
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          promptId: "prompt-default"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      prompt: {
        name: "Helpful Assistant v2",
        systemPrompt: "Be concise."
      }
    });
  });

  it("prevents deleting the default prompt preset", async () => {
    const { repository } = createMemoryRepository();
    const DELETE = createDeletePromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await DELETE(
      new Request("http://app.local/api/prompts/prompt-default", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          promptId: "prompt-default"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "default_prompt_not_deletable"
    });
  });

  it("deletes a non-default prompt preset", async () => {
    const { prompts, repository } = createMemoryRepository();
    prompts.set("prompt-custom", {
      developerPrompt: null,
      id: "prompt-custom",
      isDefault: false,
      name: "Custom",
      systemPrompt: "Custom system",
      userId: config.bootstrapUserId
    });
    const DELETE = createDeletePromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await DELETE(
      new Request("http://app.local/api/prompts/prompt-custom", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          promptId: "prompt-custom"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(prompts.has("prompt-custom")).toBe(false);
  });

  it("sets an owned prompt as the user default", async () => {
    const { defaultPrompt, prompts, repository } = createMemoryRepository();
    prompts.set("prompt-custom", {
      developerPrompt: null,
      id: "prompt-custom",
      isDefault: false,
      name: "Custom",
      systemPrompt: "Custom system",
      userId: config.bootstrapUserId
    });
    const POST = createSetDefaultPromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/prompts/prompt-custom/default", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          promptId: "prompt-custom"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(defaultPrompt.id).toBe("prompt-custom");
    expect(prompts.get("prompt-default")?.isDefault).toBe(false);
    expect(prompts.get("prompt-custom")?.isDefault).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      defaultPromptPresetId: "prompt-custom",
      prompt: {
        id: "prompt-custom",
        isDefault: true,
        name: "Custom"
      }
    });
  });

  it("moves default deletion protection when the user changes prompt defaults", async () => {
    const { prompts, repository } = createMemoryRepository();
    prompts.set("prompt-custom", {
      developerPrompt: null,
      id: "prompt-custom",
      isDefault: false,
      name: "Custom",
      systemPrompt: "Custom system",
      userId: config.bootstrapUserId
    });
    const POST = createSetDefaultPromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const DELETE = createDeletePromptHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });

    const setDefaultResponse = await POST(
      new Request("http://app.local/api/prompts/prompt-custom/default", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          promptId: "prompt-custom"
        }
      }
    );
    expect(setDefaultResponse.status).toBe(200);

    const oldDefaultDelete = await DELETE(
      new Request("http://app.local/api/prompts/prompt-default", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          promptId: "prompt-default"
        }
      }
    );
    expect(oldDefaultDelete.status).toBe(200);

    const newDefaultDelete = await DELETE(
      new Request("http://app.local/api/prompts/prompt-custom", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          promptId: "prompt-custom"
        }
      }
    );
    expect(newDefaultDelete.status).toBe(409);
    await expect(newDefaultDelete.json()).resolves.toEqual({
      error: "default_prompt_not_deletable"
    });
  });
});
