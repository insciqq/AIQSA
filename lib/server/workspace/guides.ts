import { WORKSPACE_BROWSER_GUIDANCE } from "./browserGuidance";
import { WORKSPACE_OFFICE_GUIDANCE } from "./officeGuidance";
import { WORKSPACE_PSD_GUIDANCE } from "./psdGuidance";
import { WORKSPACE_SKILLS_GUIDANCE } from "./skillsGuidance";

export const WORKSPACE_GUIDE_PATHS = {
  office: "/workspace/guides/office.md",
  browser: "/workspace/guides/browser.md",
  psd: "/workspace/guides/psd.md",
  skills: "/workspace/guides/skills.md"
} as const;

/** Release-owned files outside user projects and automatic export roots. */
export const WORKSPACE_GUIDE_FILES = [
  { name: "office.md", path: WORKSPACE_GUIDE_PATHS.office, content: WORKSPACE_OFFICE_GUIDANCE },
  { name: "browser.md", path: WORKSPACE_GUIDE_PATHS.browser, content: WORKSPACE_BROWSER_GUIDANCE },
  { name: "psd.md", path: WORKSPACE_GUIDE_PATHS.psd, content: WORKSPACE_PSD_GUIDANCE },
  { name: "skills.md", path: WORKSPACE_GUIDE_PATHS.skills, content: WORKSPACE_SKILLS_GUIDANCE }
] as const;

export const WORKSPACE_GUIDE_INPUT_MAX_BYTES = 65_536;

export function workspaceGuideInput(): Buffer {
  const input = Buffer.from(JSON.stringify({ version: 1,
    guides: WORKSPACE_GUIDE_FILES.map(({ name, content }) => ({ name, content })) }));
  if (input.byteLength > WORKSPACE_GUIDE_INPUT_MAX_BYTES) throw new Error("workspace_guide_input_too_large");
  return input;
}
