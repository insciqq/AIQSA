import { VISIBLE_ANSWER_CONTRACT, resolveStandardChatBaseline } from "../../domain/promptTemplates";
import type { InstructionPreview } from "../../contracts/instructionPreview";
import type { RequestAuthResolver } from "../auth/requestAuth";

const headers = { "cache-control": "private, no-store" };

export function createInstructionPreviewHandlers(input: {
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
}) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await input.resolveAuth(request);
      if (!auth) return Response.json({ error: "unauthorized" }, { status: 401, headers });
      if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { status: 403, headers });
      try {
        const timeZone = new URL(request.url).searchParams.get("timeZone") ?? undefined;
        const now = input.now?.() ?? new Date();
        const baseline = resolveStandardChatBaseline({ now, timeZone });
        const preview: InstructionPreview = {
          baseline,
          generatedAt: now.toISOString(),
          visibleAnswerContract: VISIBLE_ANSWER_CONTRACT
        };
        return Response.json({ preview }, { headers });
      } catch {
        return Response.json({ error: "instruction_preview_unavailable" }, { status: 503, headers });
      }
    }
  };
}
