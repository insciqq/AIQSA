import { defaultScheduledTaskHandlers } from "@/lib/server/scheduledTasks/defaultScheduledTasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = defaultScheduledTaskHandlers.list;
export const POST = defaultScheduledTaskHandlers.create;
