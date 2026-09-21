import type { SkillShareRequestState } from "@/lib/contracts/skills";

export const skillShareStateLabels: Record<SkillShareRequestState, string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Changes requested",
  withdrawn: "Withdrawn",
  superseded: "Replaced by a newer request"
};

export function skillSharingErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "unauthorized" || code === "forbidden") return "You no longer have access to review Skills.";
  if (code === "skill_share_request_not_available") return "This approval request is no longer available.";
  if (code === "skill_share_request_conflict") return "This request has changed. Refresh it before trying again.";
  if (code === "skill_version_conflict") return "The Skill changed. Reopen it before requesting approval.";
  if (code === "skill_archived") return "This Skill is archived. Restore it before requesting approval.";
  if (code === "skill_file_binary") return "This is a binary file. Only text files can be previewed.";
  return "The request could not be completed. Try again.";
}
