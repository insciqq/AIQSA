export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ImageContentBlock = {
  type: "image";
  attachmentId: string;
  alt?: string;
};

export type FileContentBlock = {
  type: "file";
  attachmentId: string;
  fileName: string;
};

export type ContentBlock = TextContentBlock | ImageContentBlock | FileContentBlock;

export type MessageContent = {
  blocks: ContentBlock[];
};

export function textMessageContent(text: string): MessageContent {
  return {
    blocks: [
      {
        type: "text",
        text
      }
    ]
  };
}
