import sharp from "sharp";
import type { KnowledgeViewerBoundingBox } from "../../contracts/knowledgeCitations";
import { preparePdfModelBatch } from "../parsing/pdfPreparation";

const MAX_HIGHLIGHTED_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_HIGHLIGHT_BOXES = 64;

type PageImage = Readonly<{
  bytes: Buffer;
  height: number;
  page: number;
  sourceHeight: number;
  sourceWidth: number;
  width: number;
}>;

export type CitationPixelRectangle = Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function citationBoxPixelRectangle(
  box: KnowledgeViewerBoundingBox,
  image: Pick<PageImage, "height" | "sourceHeight" | "sourceWidth" | "width">
): CitationPixelRectangle | null {
  if ([
    box.bottom, box.left, box.right, box.top,
    image.height, image.sourceHeight, image.sourceWidth, image.width
  ].some((value) => !Number.isFinite(value)) || image.width < 1 || image.height < 1 ||
    image.sourceWidth <= 0 || image.sourceHeight <= 0) return null;
  const left = clamp(box.left, 0, image.sourceWidth);
  const right = clamp(box.right, 0, image.sourceWidth);
  const sourceTop = box.coordinateOrigin === "bottom_left"
    ? image.sourceHeight - box.top
    : box.top;
  const sourceBottom = box.coordinateOrigin === "bottom_left"
    ? image.sourceHeight - box.bottom
    : box.bottom;
  const top = clamp(sourceTop, 0, image.sourceHeight);
  const bottom = clamp(sourceBottom, 0, image.sourceHeight);
  if (right <= left || bottom <= top) return null;
  return {
    height: (bottom - top) / image.sourceHeight * image.height,
    width: (right - left) / image.sourceWidth * image.width,
    x: left / image.sourceWidth * image.width,
    y: top / image.sourceHeight * image.height
  };
}

function overlaySvg(
  image: PageImage,
  rectangles: readonly CitationPixelRectangle[]
): Buffer {
  const shapes = rectangles.map((rectangle) =>
    `<rect x="${rectangle.x.toFixed(2)}" y="${rectangle.y.toFixed(2)}" ` +
    `width="${rectangle.width.toFixed(2)}" height="${rectangle.height.toFixed(2)}" ` +
    `rx="3" fill="#f6c945" fill-opacity="0.24" stroke="#bd7a00" ` +
    `stroke-opacity="0.92" stroke-width="2"/>`).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" ` +
    `height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">${shapes}</svg>`,
    "utf8"
  );
}

async function preparePageImage(input: Readonly<{
  bytes: Buffer;
  maxPages: number;
  page: number;
  signal?: AbortSignal;
}>, prepare: typeof preparePdfModelBatch): Promise<PageImage> {
  if (!Number.isSafeInteger(input.page) || input.page < 1 ||
    !Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || input.page > input.maxPages) {
    throw new Error("knowledge_citation_page_invalid");
  }
  const batch = await prepare({
    bytes: input.bytes,
    mode: "system_model_vision",
    pageEnd: input.page,
    pageStart: input.page,
    ...(input.signal ? { signal: input.signal } : {})
  }, { maxPages: input.maxPages });
  if (batch.kind !== "images" || batch.images.length !== 1) {
    throw new Error("knowledge_citation_page_invalid");
  }
  return batch.images[0]!;
}

async function encodePagePng(
  image: PageImage,
  rectangles: readonly CitationPixelRectangle[] = []
): Promise<Buffer> {
  const pipeline = sharp(image.bytes, { limitInputPixels: image.width * image.height });
  const rendered = await (rectangles.length > 0
    ? pipeline.composite([{ input: overlaySvg(image, rectangles) }])
    : pipeline)
    .png()
    .toBuffer();
  if (rendered.byteLength < 8 || rendered.byteLength > MAX_HIGHLIGHTED_PAGE_BYTES) {
    throw new Error("knowledge_citation_page_invalid");
  }
  return rendered;
}

/** Renders one bounded private PDF page without requiring citation coordinates. */
export async function renderKnowledgeSourcePdfPage(input: Readonly<{
  bytes: Buffer;
  maxPages: number;
  page: number;
  signal?: AbortSignal;
}>, options: Readonly<{
  prepare?: typeof preparePdfModelBatch;
}> = {}): Promise<Buffer> {
  const image = await preparePageImage(input, options.prepare ?? preparePdfModelBatch);
  return encodePagePng(image);
}

export async function renderKnowledgeCitationPdfPage(input: Readonly<{
  boxes: readonly KnowledgeViewerBoundingBox[];
  bytes: Buffer;
  maxPages: number;
  page: number;
  signal?: AbortSignal;
}>, options: Readonly<{
  prepare?: typeof preparePdfModelBatch;
}> = {}): Promise<Buffer> {
  if (input.boxes.length < 1 ||
    input.boxes.length > MAX_HIGHLIGHT_BOXES ||
    input.boxes.some((box) => box.page !== input.page)) {
    throw new Error("knowledge_citation_page_invalid");
  }
  const image = await preparePageImage(input, options.prepare ?? preparePdfModelBatch);
  const rectangles = input.boxes.flatMap((box) => {
    const rectangle = citationBoxPixelRectangle(box, image);
    return rectangle ? [rectangle] : [];
  });
  if (rectangles.length < 1) throw new Error("knowledge_citation_page_invalid");
  return encodePagePng(image, rectangles);
}
