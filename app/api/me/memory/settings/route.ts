import { defaultMemorySettingsHandlerDeps } from "@/lib/server/memory/settings/defaultSettings";
import {
  createGetMemorySettingsHandler,
  createPatchMemorySettingsHandler
} from "@/lib/server/memory/settings/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemorySettingsHandler(defaultMemorySettingsHandlerDeps);
export const PATCH = createPatchMemorySettingsHandler(defaultMemorySettingsHandlerDeps);
