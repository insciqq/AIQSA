import { RESEARCH_REVIEWS_GUIDANCE } from "../research/dataCollection";
import { workspaceBrowserGuidance, WORKSPACE_BROWSER_GUIDANCE } from "./browserGuidance";
import { WORKSPACE_OFFICE_GUIDANCE } from "./officeGuidance";
import { WORKSPACE_PSD_GUIDANCE } from "./psdGuidance";
import { WORKSPACE_PROXY_PLAN_PATH } from "./secrets/manifest";
import { WORKSPACE_SKILLS_GUIDANCE } from "./skillsGuidance";

export const WORKSPACE_GUIDE_PATHS = {
  office: "/workspace/guides/office.md",
  browser: "/workspace/guides/browser.md",
  psd: "/workspace/guides/psd.md",
  skills: "/workspace/guides/skills.md"
} as const;

/**
 * Rides on the browser guide, the one guide read before opening a site. The commands answer in a chat without proxies
 * too, so the text holds whichever a chat has (`ops/workspace-guest/python/aiqsa/proxy/`).
 */
export const WORKSPACE_PROXY_GUIDANCE = [
  "",
  "## Proxies",
  "",
  "`aiqsa-browser proxies` lists this chat's proxies, if it has any, with their countries and domain hints. A hint is advice for picking, and any proxy opens any site when named.",
  "The browser follows hints by itself: a site whose domain matches a hint opens through that proxy, proxies for the same zone take turns between sites, and a site stays on its proxy. Other sites open directly. The step line says what opened a site, such as `[browser #1] open: through proxy KZ1 (KZ) @ shop.kz/`.",
  "`open URL --proxy NAME` opens a site through the proxy you name, and `--proxy direct` without one; `--proxy auto` follows the hints again (also `new-tab URL --proxy NAME`, and in Python `b.open(url, proxy=\"NAME\")`). The choice holds for that site until you change it or this turn ends. A site has one exit at a time: when two agents name different proxies for one site the later choice applies to both, and the other agent is told; sign-ins stay shared either way.",
  "When proxies arrive in a chat whose browser is already open, the browser restarts through them: open tabs close, with a note naming them, and sign-ins stay. A tab the user holds in the live view waits for them, and until then other browser commands fail with `proxy_browser_restart_pending`: try again shortly.",
  "A proxy that does not work moves the site to the next one that matches. With none left, the command fails with `proxy_all_failed` naming what was tried, and nothing goes direct unless you say `--proxy direct`. A proxy you named is not moved on from: its failure comes back to you.",
  "A site that answers 401, 403, 407, 451 or 498, or refuses the connection, may be blocking the address it sees, even when no hint matched: the output names the proxies to try. Try one that fits the site's country, then say in your answer what opened it. `aiqsa-browser proxies HOST` shows the same for any host. Never try to solve or get around a CAPTCHA this way.",
  "Some sites first answer with a block status such as 498 or a check page and pass within about 15 seconds: wait and read the page again before calling a site blocked.",
  "",
  "Commands do not use proxies by themselves. Run one through them with `aiqsa-browser proxied`, which picks per site as the browser does, for `curl`, `wget` and scripts that honor the usual proxy variables: `aiqsa-browser proxied curl -sS https://shop.kz/`, or `aiqsa-browser proxied --proxy NAME python3 script.py`. A failure there is a 502 from the proxy address, and `aiqsa-browser proxies HOST` says why. Private and local addresses are refused, and Internet Off stops proxies too.",
  `A program with its own proxy setting can read the logins and passwords from \`${WORKSPACE_PROXY_PLAN_PATH}\`. Read them only for that, and keep them out of project files and downloads.`,
  "",
  "If `aiqsa-browser proxies` is refused as an invalid choice, this chat's Workspace still runs an older image, which it keeps until the Workspace is recreated: sites open without a proxy here, whatever the hints say, and a new chat starts on the current image. Say so in your answer when the address a site sees matters."
].join("\n");

const browserGuide = (guide: string) => `${guide}\n${WORKSPACE_PROXY_GUIDANCE}\n${RESEARCH_REVIEWS_GUIDANCE}`;

/** Release-owned files outside user projects and automatic export roots. */
export const WORKSPACE_GUIDE_FILES = [
  { name: "office.md", path: WORKSPACE_GUIDE_PATHS.office, content: WORKSPACE_OFFICE_GUIDANCE },
  { name: "browser.md", path: WORKSPACE_GUIDE_PATHS.browser, content: browserGuide(WORKSPACE_BROWSER_GUIDANCE) },
  { name: "psd.md", path: WORKSPACE_GUIDE_PATHS.psd, content: WORKSPACE_PSD_GUIDANCE },
  { name: "skills.md", path: WORKSPACE_GUIDE_PATHS.skills, content: WORKSPACE_SKILLS_GUIDANCE }
] as const;

export const WORKSPACE_GUIDE_INPUT_MAX_BYTES = 65_536;

export function workspaceGuideInput(options: Readonly<{ agentKind?: "main" | "subagent"; imageRef?: string }> = {}): Buffer {
  const browser = browserGuide(workspaceBrowserGuidance(options.agentKind, options.imageRef));
  const input = Buffer.from(JSON.stringify({ version: 1,
    guides: WORKSPACE_GUIDE_FILES.map(({ name, content }) => ({ name, content: name === "browser.md" ? browser : content })) }));
  if (input.byteLength > WORKSPACE_GUIDE_INPUT_MAX_BYTES) throw new Error("workspace_guide_input_too_large");
  return input;
}
