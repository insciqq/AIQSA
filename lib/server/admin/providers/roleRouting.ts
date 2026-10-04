import { openRouterSelectedProvidersMissingParameters, type NativeProviderEndpoint } from "../../../domain/openRouterNativeRouting";
import type { AdminProviderAssignedRole, AdminProviderRoleRoutingConflict } from "../../../contracts/adminProviderRoleRouting";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";

/**
 * OpenRouter request kinds each installation role sends with
 * `require_parameters`: structured output and strict Memory actions are
 * separate requests, so each set needs one selected endpoint listing all of it.
 * Image and PDF input are not catalog parameters; their capability checks
 * remain the only proof for the Vision and PDF roles.
 */
const ROLE_PARAMETER_SETS: Readonly<Record<AdminProviderAssignedRole, readonly (readonly string[])[]>> = {
  memory: [["response_format", "structured_outputs"], ["tools"]],
  system_model: [["response_format", "structured_outputs"], ["tools"]],
  chat_titles: [["response_format", "structured_outputs"]],
  vision: [],
  chat_pdf: [],
  chat_pdf_native: []
};

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
  const roles = input.roles.filter((role) => ROLE_PARAMETER_SETS[role].length > 0);
  if (!providers || !roles.length) return null;
  if (input.active && input.active.upstreamModelId === input.draft.upstreamModelId &&
    JSON.stringify(selectedProviders(input.active)) === JSON.stringify(providers)) return null;
  return { providers, roles };
}

export function roleRoutingConflicts(input: {
  roles: readonly AdminProviderAssignedRole[];
  providers: readonly string[];
  endpoints: readonly NativeProviderEndpoint[];
}): AdminProviderRoleRoutingConflict[] {
  return input.roles.flatMap((role) => {
    const missingParameters = openRouterSelectedProvidersMissingParameters({
      providers: input.providers, endpoints: input.endpoints, parameterSets: ROLE_PARAMETER_SETS[role]
    });
    return missingParameters.length ? [{ role, missingParameters }] : [];
  });
}
