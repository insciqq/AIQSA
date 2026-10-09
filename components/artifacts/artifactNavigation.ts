import { ARTIFACT_PAGE_HEADER, artifactPagePath } from "@/lib/contracts/artifacts";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_FRAGMENT_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";

/** One request for a page of the shown version: its entry page when `page` is absent. */
export type ArtifactPageRequest = Readonly<{ page?: string; fragment?: string; focus: boolean; serial: number }>;

/** The query that selects a page; the entry page needs none. */
export function artifactPageSearch(page?: string): string {
  return page === undefined ? "" : `?${new URLSearchParams({ page })}`;
}

/** The page a content response holds, as the server names it; null when absent or malformed. */
export function artifactResponsePage(response: Response): string | null {
  return artifactPagePath(response.headers.get(ARTIFACT_PAGE_HEADER));
}

/**
 * Hands the #fragment of the link that opened a page to that page's server bridge, which
 * scrolls there after load. Like the storage snapshot, only the unique marker inside the
 * unique bridge script is filled, as an inert literal that cannot carry another marker.
 */
export function injectArtifactArrivalFragment(body: string, fragment?: string): string {
  if (!fragment) return body;
  const start = body.indexOf(ARTIFACT_BRIDGE_SCRIPT_OPEN);
  const marker = body.indexOf(ARTIFACT_FRAGMENT_PLACEHOLDER);
  if (start < 0 || marker < start + ARTIFACT_BRIDGE_SCRIPT_OPEN.length ||
    body.indexOf(ARTIFACT_BRIDGE_SCRIPT_OPEN, start + 1) >= 0 || body.indexOf(ARTIFACT_FRAGMENT_PLACEHOLDER, marker + 1) >= 0) return body;
  const end = body.indexOf("</script>", start);
  if (end < 0 || marker >= end) return body;
  // Escaped like the server's site data: no markup, comment or marker can start inside it.
  const literal = JSON.stringify(fragment).replace(/[<>&*\p{Zl}\p{Zp}]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return body.slice(0, marker) + literal + body.slice(marker + ARTIFACT_FRAGMENT_PLACEHOLDER.length);
}
