import type { NativeRouteAdoptionStatus } from "@/lib/contracts/nativeRoutingAdoption";
import { CAPABILITY_LABELS } from "../add/AdminProviderSetupResults";

export function NativeRoutingAdoptionNote({ status }: { status: NativeRouteAdoptionStatus }) {
  const diagnostic = status.diagnostic;
  const explanation = status.reason === "native_unavailable" ? "No native provider endpoint was available for this model."
    : status.reason === "publisher_unknown" ? "A native provider mapping was not available for this publisher."
    : status.reason === "native_incompatible" ? "The native route did not pass the required checks."
    : "Native provider setup could not be completed.";
  const stages = { catalog: "Endpoint discovery", modelAccess: "Model access", capabilities: "Capabilities", publication: "Settings changed during checks" };
  return (
    <details className="my-2 min-w-0 text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">
      <summary className="cursor-pointer rounded py-3 text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Automatic routing kept during native setup
      </summary>
      <div className="space-y-1 pb-2">
        <p>{explanation} The saved route and model checks were kept.</p>
        {diagnostic ? <>
          <p>Stage: {stages[diagnostic.stage]}. {diagnostic.provider ? `Provider: ${diagnostic.provider}. ` : ""}
            {diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}. ` : ""}Code: {diagnostic.code}.</p>
          {diagnostic.missing.length > 0 ? <p>Requirements not verified: {diagnostic.missing.map((check) =>
            check === "maxOutputTokens" ? "Output limit" : CAPABILITY_LABELS[check]).join(", ")}.</p> : null}
          {diagnostic.previouslyUnverified.length > 0 ? <p>Saved capabilities also lacked earlier verification: {diagnostic.previouslyUnverified.map((check) => CAPABILITY_LABELS[check]).join(", ")}.</p> : null}
        </> : <p>Detailed evidence is unavailable for this earlier attempt.</p>}
        <p>Review the route and use Test &amp; Save to check a new selection.</p>
      </div>
    </details>
  );
}
