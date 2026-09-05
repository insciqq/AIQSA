import type { ProjectAuditEventWire } from "@/lib/contracts/projects";

const activityLabels: Readonly<Record<string, string>> = {
  deletion_requested: "Project deletion requested",
  defaults_updated: "Project defaults updated",
  group_grant_added: "Group access added",
  group_grant_changed: "Group role changed",
  group_grant_removed: "Group access removed",
  instructions_updated: "Project instructions updated",
  memory_policy_updated: "Project Memory updated",
  policy_updated: "Project policy updated",
  project_archived: "Project archived",
  project_chat_archived: "Shared chat archived",
  project_chat_created: "Shared chat created",
  project_chat_restored: "Shared chat restored",
  project_created: "Project created",
  project_description_updated: "Project description updated",
  project_folder_created: "Folder created",
  project_folder_deleted: "Folder removed",
  project_folder_updated: "Folder updated",
  project_renamed: "Project renamed",
  project_restored: "Project restored",
  public_sharing_disabled: "Public sharing disabled",
  public_sharing_enabled: "Public sharing enabled",
  public_snapshot_created: "Public snapshot created",
  public_snapshot_revoked: "Public snapshot revoked",
  resource_attached: "Shared resource added",
  resource_detached: "Shared resource removed",
  resource_owner_revoked: "Resource owner revoked Project publication",
  resource_dependencies_refreshed: "Assistant dependencies refreshed",
  user_grant_added: "Member access added",
  user_grant_changed: "Member role changed",
  user_grant_removed: "Member access removed",
  user_left_project: "Member left the Project"
};

export function projectActivityLabel(eventType: string): string {
  return activityLabels[eventType] ?? "Project activity";
}

export function projectActivityDetail(event: ProjectAuditEventWire): string | null {
  const metadata = event.metadata;
  const details: string[] = [];
  const fromRole = typeof metadata.fromRole === "string" ? metadata.fromRole.toLowerCase() : null;
  const toRole = typeof metadata.toRole === "string" ? metadata.toRole.toLowerCase() : null;
  const role = typeof metadata.role === "string" ? metadata.role.toLowerCase() : null;
  const resourceType = typeof metadata.resourceType === "string" ? metadata.resourceType : null;
  if (fromRole && toRole) details.push(`Role changed from ${fromRole} to ${toRole}.`);
  else if (role) details.push(`${role[0]?.toUpperCase()}${role.slice(1)} access.`);
  if (resourceType) details.push(`${resourceType === "mcp" ? "MCP" : resourceType} resource.`);
  const affectedChats = typeof metadata.affectedChatCount === "number" ? metadata.affectedChatCount : 0;
  const dependentAssistants = typeof metadata.dependentAssistantCount === "number"
    ? metadata.dependentAssistantCount
    : 0;
  const clearedDefaults = typeof metadata.clearedDefaultCount === "number"
    ? metadata.clearedDefaultCount
    : 0;
  if (affectedChats > 0) {
    details.push(`${affectedChats} chat default${affectedChats === 1 ? "" : "s"} cleared.`);
  }
  if (dependentAssistants > 0) {
    details.push(
      `${dependentAssistants} dependent Assistant${dependentAssistants === 1 ? "" : "s"} removed.`
    );
  }
  if (clearedDefaults > 0) {
    details.push(`${clearedDefaults} Project default${clearedDefaults === 1 ? "" : "s"} cleared.`);
  }
  if (typeof metadata.enabled === "boolean") {
    details.push(metadata.enabled ? "Enabled for future use." : "Disabled for future use.");
  }
  return details.length > 0 ? details.join(" ") : null;
}

export function formatProjectDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date)
    : "Unknown date";
}
