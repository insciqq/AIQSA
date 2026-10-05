/**
 * Hand-written synthetic ChatGPT export conversations shaped like the two
 * export layouts: the sharded export (nodes carry only `{id, message,
 * parent}`) and the legacy single `conversations.json` (nodes also list
 * `children`; system, tool, code and execution-output nodes). No real content.
 */
type Json = Record<string, unknown>;

const T0 = 1_757_000_000; // 2025-09-04T15:33:20Z

export const CITE = (ref: string) => `\ue200cite\ue202${ref}\ue201`;
let messageCount = 0;

export const ENTITY = (name: string) => `\ue200entity\ue202${JSON.stringify(["people", name, "synthetic"])}\ue201`;

export function message(
  role: string,
  content: Json,
  options: Readonly<{ time?: number | null; metadata?: Json; recipient?: string; name?: string }> = {}
): Json {
  return {
    author: { metadata: {}, name: options.name ?? null, role },
    content,
    ...(options.time === null ? {} : { create_time: options.time ?? T0 }),
    id: `msg-${(messageCount += 1)}`,
    ...(options.metadata ? { metadata: options.metadata } : {}),
    recipient: options.recipient ?? "all",
    status: "finished_successfully"
  };
}

export const text = (...parts: readonly string[]): Json => ({ content_type: "text", parts });

/** A sharded-export node: parent only. */
function node(id: string, parent: string | null, value: Json | null): Json {
  return { id, message: value, parent };
}

function mapping(nodes: readonly Json[]): Json {
  return Object.fromEntries(nodes.map((entry) => [entry.id as string, entry]));
}

/**
 * Branches: the first prompt edited (two roots), an answer split across two
 * nodes after hidden reasoning, a regenerated answer, a hidden trailing
 * message as `current_node`, and a web citation.
 */
export function branchedConversation(): Json {
  return {
    conversation_id: "conv-branches",
    conversation_template_id: null,
    create_time: T0,
    current_node: "hidden",
    default_model_slug: "gpt-synthetic",
    id: "conv-branches",
    is_archived: false,
    is_starred: true,
    is_study_mode: false,
    mapping: mapping([
      node("root", null, null),
      node("sys", "root", message("system", text(""), { metadata: { is_visually_hidden_from_conversation: true } })),
      node("u1", "sys", message("user", text("First question"), { time: T0 + 10 })),
      node("u1b", "sys", message("user", text("First question, edited"), { time: T0 + 100 })),
      node("think", "u1", message("assistant", { content_type: "thoughts", thoughts: [{ content: "hidden", summary: "s" }] }, { time: T0 + 11 })),
      node("recap", "think", message("assistant", { content_type: "reasoning_recap", content: "Thought for 2s" }, { time: T0 + 12 })),
      node("a1", "recap", message("assistant", text(`Answer part one ${CITE("turn0search0")}.`), {
        metadata: {
          content_references: [{
            end_idx: 40,
            items: [{ attribution: "Example", title: "Example article", url: "https://example.com/article" }],
            matched_text: CITE("turn0search0"),
            start_idx: 16,
            type: "grouped_webpages"
          }],
          model_slug: "gpt-synthetic"
        },
        time: T0 + 13
      })),
      node("a1-tail", "a1", message("assistant", text("Answer part two"), { time: T0 + 14 })),
      node("u2", "a1-tail", message("user", text("Follow up"), { time: T0 + 20 })),
      node("a2", "u2", message("assistant", text("First answer to follow up"), { time: T0 + 21 })),
      node("a2r", "u2", message("assistant", text("Regenerated answer to follow up"), { time: T0 + 22 })),
      node("hidden", "a2r", message("assistant", text("Memory updated"), {
        metadata: { is_visually_hidden_from_conversation: true },
        time: T0 + 23
      })),
      node("a1b", "u1b", message("assistant", text("Answer to the edited question"), { time: T0 + 101 }))
    ]),
    pinned_time: null,
    title: "Branches",
    update_time: T0 + 200,
    voice: null
  };
}

/**
 * Multimodal parts with images, audio and a transcription, an uploaded
 * file, custom instructions, missing dates, an empty title and no current node.
 */
export function multimodalConversation(): Json {
  return {
    conversation_id: "conv-media",
    create_time: T0 + 1_000,
    default_model_slug: null,
    id: "conv-media",
    is_archived: true,
    is_starred: false,
    mapping: mapping([
      node("root", null, null),
      node("ctx", "root", message("user", { content_type: "user_editable_context", user_instructions: "Be brief" }, {
        metadata: { is_visually_hidden_from_conversation: true }
      })),
      node("u1", "ctx", message("user", {
        content_type: "multimodal_text",
        parts: [
          { asset_pointer: "file-service://file-img1", content_type: "image_asset_pointer", height: 10, width: 10 },
          "What is in this picture?"
        ]
      }, {
        metadata: { attachments: [{ id: "file-img1", name: "photo.png" }, { id: "file-doc1", name: "notes.pdf" }] },
        time: null
      })),
      node("a1", "u1", message("assistant", text("A synthetic cat."), { time: T0 + 1_010 })),
      node("u2", "a1", message("user", {
        content_type: "multimodal_text",
        parts: [
          { content_type: "audio_transcription", direction: "in", text: "Spoken question" },
          { asset_pointer: "sediment://file_audio1", content_type: "audio_asset_pointer", format: "wav" }
        ]
      }, { time: T0 + 1_020 })),
      // Created "before" its parent: kept no earlier than the question.
      node("a2", "u2", message("assistant", {
        content_type: "multimodal_text",
        parts: [
          { content_type: "audio_transcription", direction: "out", text: "Spoken answer" },
          { content_type: "real_time_user_audio_video_asset_pointer", frames_asset_pointers: [] }
        ]
      }, { time: T0 + 1_005 })),
      node("u3", "a2", message("user", {
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "file-service://file-img2", content_type: "image_asset_pointer" }]
      }, { time: T0 + 1_030 }))
    ]),
    pinned_time: T0 + 1_500,
    title: "  ",
    update_time: T0 + 1_100
  };
}

/** One answer citing every reference type ChatGPT writes, plus an unreferenced marker and a stray marker character. */
export function citationsConversation(): Json {
  const answer = [
    `Web ${CITE("turn0search0")}.`,
    `Extended ${CITE("turn0search1")}.`,
    `About ${ENTITY("Ada Lovelace")} today.`,
    `From the file ${CITE("turn0file0")}.`,
    `Hidden ${CITE("turn0search9")}.`,
    `Products ${"\ue200products\ue202{\"selections\":[]}\ue201"}`,
    `Navigation ${"\ue200navlist\ue202Links\ue202turn0news1\ue201"}`,
    `Plain url ${CITE("turn0url0")}.`,
    `Picture ${"\ue200i\ue202turn0image0\ue201"}`,
    `Unknown ${CITE("turn0x0")}.`,
    `Orphan ${CITE("turn9search9")}.`,
    `Stray\ue203 character.`
  ].join("\n");
  const ref = (matched: string, extra: Json) => ({ end_idx: 0, matched_text: matched, start_idx: answer.indexOf(matched), ...extra });
  return {
    conversation_id: "conv-citations",
    create_time: T0 + 2_000,
    current_node: "a1",
    default_model_slug: "gpt-synthetic-search",
    id: "conv-citations",
    mapping: mapping([
      node("root", null, null),
      node("u1", "root", message("user", text("Search something"), { time: T0 + 2_001 })),
      node("a1", "u1", message("assistant", text(answer), {
        metadata: {
          content_references: [
            ref(CITE("turn0search0"), {
              items: [
                { attribution: "One", title: "First [source]", url: "https://one.example/a_(b)" },
                { attribution: "Two", title: "", url: "https://two.example/" }
              ],
              type: "grouped_webpages"
            }),
            ref(CITE("turn0search1"), { title: "Extended page", type: "webpage_extended", url: "https://ext.example/page" }),
            ref(ENTITY("Ada Lovelace"), { name: "Ada Lovelace", type: "entity" }),
            ref(CITE("turn0file0"), { name: "report.pdf", type: "file" }),
            ref(CITE("turn0search9"), { type: "hidden" }),
            ref("\ue200products\ue202{\"selections\":[]}\ue201", {
              products: [{ title: "Synthetic kettle", url: "https://shop.example/kettle" }, { title: "No link" }],
              type: "products"
            }),
            ref("\ue200navlist\ue202Links\ue202turn0news1\ue201", {
              items: [{ title: "News one", url: "https://news.example/1" }],
              type: "nav_list"
            }),
            ref(CITE("turn0url0"), { title: "Url title", type: "url", url: "https://url.example/" }),
            ref("\ue200i\ue202turn0image0\ue201", { images: [{ url: "https://img.example/1.png" }], type: "image_inline" }),
            ref(CITE("turn0x0"), { type: "something_new", url: "https://unknown.example/" }),
            { end_idx: answer.length, matched_text: " ", sources: [
              { attribution: "One", title: "First source", url: "https://one.example/a_(b)" },
              { title: "Javascript", url: "javascript:alert(1)" }
            ], start_idx: answer.length, type: "sources_footnote" }
          ]
        },
        time: T0 + 2_002
      }))
    ]),
    title: "Citations",
    update_time: T0 + 2_003
  };
}

/** Only a system message: nothing to import. */
export function emptyConversation(): Json {
  return {
    conversation_id: "conv-empty",
    create_time: T0 + 3_000,
    current_node: "sys",
    id: "conv-empty",
    mapping: mapping([node("root", null, null), node("sys", "root", message("system", text("You are ChatGPT")))]),
    title: "Empty",
    update_time: T0 + 3_000
  };
}

/** A legacy node: parent and children. */
function legacyNode(id: string, parent: string | null, children: readonly string[], value: Json | null): Json {
  return { children, id, message: value, parent };
}

/**
 * Legacy layout: code interpreter (code → execution output → answer),
 * browsing (tool traffic and a `【n†source】` citation) and an image
 * generated by a tool, with float timestamps.
 */
export function legacyToolConversation(): Json {
  const browsed = "News 【11†source】 today.";
  return {
    create_time: T0 + 4_000.25,
    current_node: "a3",
    default_model_slug: "gpt-legacy",
    id: "legacy-tools",
    mapping: mapping([
      legacyNode("root", null, ["sys"], null),
      legacyNode("sys", "root", ["u1"], message("system", text(""), { time: null })),
      legacyNode("u1", "sys", ["c1"], message("user", text("Compute something"), { time: T0 + 4_001.5 })),
      legacyNode("c1", "u1", ["o1"], message("assistant", { content_type: "code", language: "python", text: "print(\"```\")\n" }, {
        recipient: "python",
        time: T0 + 4_002
      })),
      legacyNode("o1", "c1", ["a1"], message("tool", { content_type: "execution_output", text: "```\nline two" }, {
        name: "python",
        time: T0 + 4_003
      })),
      legacyNode("a1", "o1", ["u2"], message("assistant", text("Done."), { time: T0 + 4_004 })),
      legacyNode("u2", "a1", ["b1"], message("user", text("Search the news"), { time: T0 + 4_010 })),
      legacyNode("b1", "u2", ["t1"], message("assistant", { content_type: "code", language: "unknown", text: "search(\"news\")" }, {
        recipient: "browser",
        time: T0 + 4_011
      })),
      legacyNode("t1", "b1", ["e1"], message("tool", { content_type: "tether_browsing_display", result: "results" }, {
        name: "browser",
        time: T0 + 4_012
      })),
      legacyNode("e1", "t1", ["a2"], message("tool", { content_type: "system_error", name: "Error", text: "timeout" }, { time: T0 + 4_013 })),
      legacyNode("a2", "e1", ["u3"], message("assistant", text(browsed), {
        metadata: {
          citations: [{
            end_ix: browsed.indexOf("】") + 1,
            metadata: { title: "News site", type: "webpage", url: "https://news.example/a" },
            start_ix: browsed.indexOf("【")
          }]
        },
        time: T0 + 4_014
      })),
      legacyNode("u3", "a2", ["d1"], message("user", text("Draw a cat"), { time: T0 + 4_020 })),
      legacyNode("d1", "u3", ["a3"], message("tool", {
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "file-service://file-gen1", content_type: "image_asset_pointer" }]
      }, { name: "dalle.text2im", time: T0 + 4_021 })),
      legacyNode("a3", "d1", [], message("assistant", text("Here is your cat."), { time: T0 + 4_022 }))
    ]),
    title: "Legacy tools",
    update_time: T0 + 4_100
  };
}

/** Legacy branches whose `children` order differs from creation order. */
export function legacyBranchConversation(): Json {
  return {
    create_time: T0 + 5_000,
    current_node: "a1",
    id: "legacy-branch",
    mapping: mapping([
      legacyNode("root", null, ["u1"], null),
      legacyNode("u1", "root", ["a1", "a1b"], message("user", text("Question"), { time: T0 + 5_001 })),
      legacyNode("a1", "u1", [], message("assistant", text("Listed first, created later"), { time: T0 + 5_010 })),
      legacyNode("a1b", "u1", [], message("assistant", text("Listed second, created earlier"), { time: T0 + 5_002 }))
    ]),
    title: "Legacy branch",
    update_time: T0 + 5_020
  };
}

/** Claude's export also ships a `conversations.json` array; its items have no `mapping`. */
export function claudeLikeConversations(): Json[] {
  return [{ chat_messages: [{ sender: "human", text: "Hi", uuid: "c1" }], name: "Claude chat", uuid: "claude-1" }];
}

/** The sharded export's index. */
export function exportManifest(paths: readonly string[]): Json {
  return {
    export_files: [
      ...paths.map((path) => ({ path, size_bytes: 1_000 })),
      { path: "chat.html", size_bytes: 5_000 },
      { path: "user.json", size_bytes: 100 }
    ],
    logical_files: [{ files: paths, name: "conversations.json" }],
    version: 1
  };
}
