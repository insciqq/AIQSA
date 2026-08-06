import {
  assistantAvatarRecipeFromBytes,
  ASSISTANT_AVATAR_RECIPE_MIN_BYTES,
  type AssistantAvatarRecipe
} from "@/lib/contracts/assistants";

/**
 * Browser-only avatar generation: Web Crypto random bytes through the pure
 * bounded generator. It performs no network request, and callers roll it
 * exactly once per new draft plus once per explicit `Generate another`;
 * rerenders, reopen, and theme changes never reroll a recipe.
 */
export function generateAssistantAvatarRecipe(): AssistantAvatarRecipe {
  const bytes = new Uint8Array(ASSISTANT_AVATAR_RECIPE_MIN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return assistantAvatarRecipeFromBytes(bytes);
}
