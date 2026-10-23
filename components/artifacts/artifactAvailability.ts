/** Presentation only; admission independently checks the same product boundaries. */
export function artifactUnavailableReason({ temporary }: { temporary: boolean }): string | null {
  return temporary ? "Not available in temporary chats" : null;
}
