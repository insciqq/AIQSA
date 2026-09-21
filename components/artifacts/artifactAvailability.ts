/** Presentation only; admission independently checks the same product boundaries. */
export function artifactUnavailableReason({ agent, project, temporary }: { agent: boolean; project: boolean; temporary: boolean }): string | null {
  return agent ? "Not available in Agent mode" : project ? "Not available in projects"
    : temporary ? "Not available in temporary chats" : null;
}
