import { describe, expect, it } from "vitest";
import { renderSelectedSkillContext, withSelectedSkillContext } from "./userContext";

describe("selected Skill user context", () => {
  it("renders ordered, structurally escaped text and inserts it before the current user", () => {
    const skills = [{
      instructions: "Check <facts> & cite 'sources'.",
      name: 'Reviewer & "editor"',
      revisionId: "revision-1",
      skillId: "skill-1"
    }];
    const rendered = renderSelectedSkillContext(skills);
    const messages = withSelectedSkillContext([
      {
        content: { blocks: [{ text: "Earlier answer", type: "text" }] },
        id: "assistant-1",
        role: "assistant"
      },
      {
        content: { blocks: [{ text: "Actual question", type: "text" }] },
        id: "user-2",
        role: "user"
      }
    ], skills);

    expect(rendered).toBe([
      "<selected_skills>",
      "  <skill name=\"Reviewer &amp; &quot;editor&quot;\">",
      "Check &lt;facts&gt; &amp; cite &apos;sources&apos;.",
      "  </skill>",
      "</selected_skills>"
    ].join("\n"));
    expect(messages.map(({ id }) => id)).toEqual([
      "assistant-1",
      "skill-context:user-2",
      "user-2"
    ]);
    expect(messages[1]).toMatchObject({ purpose: "skill_context", role: "user" });
    expect(messages.at(-1)?.content).toEqual({
      blocks: [{ text: "Actual question", type: "text" }]
    });
  });
});
