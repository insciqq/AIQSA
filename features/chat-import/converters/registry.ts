import { createAiqsaConverter } from "./aiqsaConverter";
import { createChatGptConverter } from "./chatgptConverter";
import type { ChatImportConverter } from "./converterTypes";

/**
 * The converters of one import, in detection order: each claims files among
 * those the earlier ones left. They are created per import because they may
 * hold what detection learned about the files.
 */
export function createChatImportConverters(): readonly ChatImportConverter[] {
  return [createAiqsaConverter(), createChatGptConverter()];
}
