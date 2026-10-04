import { decodeUserImageModelChoice } from "../../contracts/imageModels";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { UserImageModelError, type UserImageModelService } from "./userImageModels";

const headers = { "cache-control": "private, no-store" };

/** The current user's image model: the published list and one choice. */
export function createUserImageModelHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: Pick<UserImageModelService, "read" | "select">;
}>) {
  async function authorize(request: Request) {
    const auth = await input.resolveAuth(request);
    if (!auth) return { error: Response.json({ error: "unauthorized" }, { status: 401 }), userId: null };
    if (auth.user.status !== "active") return { error: Response.json({ error: "forbidden" }, { status: 403 }), userId: null };
    return { error: null, userId: auth.userId };
  }
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.error) return auth.error;
      try {
        return Response.json({ imageModel: await input.service.read(auth.userId) }, { headers });
      } catch {
        return Response.json({ error: "image_models_unavailable" }, { status: 503, headers });
      }
    },
    async PATCH(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.error) return auth.error;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      const choice = decodeUserImageModelChoice(value);
      if (!choice) return Response.json({ error: "image_model_input_invalid" }, { status: 400, headers });
      try {
        return Response.json({ imageModel: await input.service.select(auth.userId, choice.providerModelId) }, { headers });
      } catch (error) {
        if (error instanceof UserImageModelError) return Response.json({ error: error.code }, { status: 409, headers });
        return Response.json({ error: "image_models_unavailable" }, { status: 503, headers });
      }
    }
  };
}
