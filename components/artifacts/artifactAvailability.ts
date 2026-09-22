/** Presentation only; admission independently checks the same product boundaries. */
export function artifactUnavailableReason({ project, temporary }: { agent: boolean; project: boolean; temporary: boolean }): string | null {
  return project ? "Not available in projects"
    : temporary ? "Not available in temporary chats" : null;
}
