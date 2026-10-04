import { OPENROUTER_ROLE_PARAMETER_SETS } from "../../../domain/openRouterNativeRouting";
import type { AdminProviderAssignedRole } from "../../../contracts/adminProviderRoleRouting";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";

export { openRouterRoleRoutingConflicts as roleRoutingConflicts } from "../../../domain/openRouterNativeRouting";

function selectedProviders(model: ProviderModelConfiguration): readonly string[] | null {
  return model.adapterKind === "openrouter_chat_completions" && model.openRouterRouting?.mode === "only_selected"
    ? model.openRouterRouting.providers : null;
}

/** Roles whose catalog requirements must be rechecked before this draft goes
 * live: only a changed provider restriction (or model) can newly exclude them. */
export function rolesNeedingRoutingCheck(input: {
  roles: readonly AdminProviderAssignedRole[];
  draft: ProviderModelConfiguration;
  active: ProviderModelConfiguration | null;
}): { providers: readonly string[]; roles: AdminProviderAssignedRole[] } | null {
  const providers = selectedProviders(input.draft);
  const roles = input.roles.filter((role) => OPENROUTER_ROLE_PARAMETER_SETS[role].length > 0);
  if (!providers || !roles.length) return null;
  if (input.active && input.active.upstreamModelId === input.draft.upstreamModelId &&
    JSON.stringify(selectedProviders(input.active)) === JSON.stringify(providers)) return null;
  return { providers, roles };
}
