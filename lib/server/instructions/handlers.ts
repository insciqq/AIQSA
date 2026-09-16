import { decodeInstructionPresetMutation } from "../../contracts/instructionPresets";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { InstructionPresetError, type InstructionPresetStore } from "./store";

const headers = { "cache-control": "private, no-store" };
export function createInstructionPresetHandlers(input: { resolveAuth: RequestAuthResolver; store: InstructionPresetStore }) {
  async function handle(request: Request, mode: "list" | "detail" | "mutate", id?: string): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { status: 403, headers });
    try {
      if (mode === "detail") {
        const preset = id && id.length <= 128 ? await input.store.get(auth.userId, id) : null;
        return preset ? Response.json({ preset }, { headers }) : Response.json({ error: "instruction_preset_not_found" }, { status: 404, headers });
      }
      if (mode === "mutate") {
        const raw = await readJsonBodyOrNull(request);
        const bodyError = requestBodyErrorResponse(raw);
        if (bodyError) return bodyError;
        const mutation = decodeInstructionPresetMutation(raw);
        if (!mutation) throw new InstructionPresetError("instruction_preset_invalid");
        await input.store.mutate(auth.userId, mutation);
      }
      return Response.json({ instructions: await input.store.list(auth.userId) }, { headers });
    } catch (error) {
      const code = error instanceof InstructionPresetError ? error.code : "instruction_presets_unavailable";
      const status = code === "instruction_preset_not_found" ? 404 : code.endsWith("conflict") ? 409 : code === "instruction_presets_unavailable" ? 503 : 400;
      return Response.json({ error: code }, { status, headers });
    }
  }
  return {
    GET: (request: Request) => handle(request, "list"),
    POST: (request: Request) => handle(request, "mutate"),
    detail: (request: Request, id: string) => handle(request, "detail", id)
  };
}
