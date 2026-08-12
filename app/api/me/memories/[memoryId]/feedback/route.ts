import { defaultMemoryReviewHandlerDeps } from "@/lib/server/memory/review/defaultReview";
import { createRecordMemoryFeedbackHandler } from "@/lib/server/memory/review/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createRecordMemoryFeedbackHandler(defaultMemoryReviewHandlerDeps);
