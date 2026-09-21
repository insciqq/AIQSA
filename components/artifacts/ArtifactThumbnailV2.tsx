"use client";

import { useEffect, useRef, useState } from "react";
import type { ArtifactKind } from "@/lib/contracts/artifacts";
import { UiV2Icon } from "@/components/ui-v2";
import { artifactKindIcon } from "./artifactPresentation";

const maxVersionBytes = 1.5 * 1024 * 1024;
// Base64 in the rendered document can be larger than the original files.
const maxResponseBytes = 3 * 1024 * 1024;
const kinds = new Set<ArtifactKind>(["html", "slides", "svg", "chart", "image"]);
let activeRequests = 0;
const waiting: Array<() => void> = [];

function limitedRequest(signal: AbortSignal, request: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { abort(); return; }
      activeRequests += 1;
      void request().then(resolve, reject).finally(() => {
        activeRequests -= 1;
        waiting.shift()?.();
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (activeRequests < 6) start();
    else waiting.push(start);
  });
}

async function thumbnailBody(response: Response): Promise<string> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxResponseBytes) throw new Error("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxResponseBytes) throw new Error("too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0];
  if (["image/png", "image/jpeg", "image/webp"].includes(mimeType ?? "")) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}img{width:100%;height:100%;object-fit:contain}</style><img alt="" src="data:${mimeType};base64,${btoa(binary)}">`;
  }
  if (mimeType !== "text/html" && mimeType !== "image/svg+xml") throw new Error("unsupported");
  return new TextDecoder().decode(bytes);
}

export function ArtifactThumbnailV2({ artifactId, versionId, kind, byteSize }: {
  artifactId: string; versionId: string; kind: ArtifactKind; byteSize?: number;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<{ versionId: string; html: string } | null>(null);
  const eligible = kinds.has(kind) && byteSize !== undefined && byteSize >= 0 && byteSize <= maxVersionBytes;
  useEffect(() => {
    if (!eligible || !target.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      setVisible(visible);
      if (!visible) setPreview(null);
    });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [eligible]);
  useEffect(() => {
    if (!visible || !eligible) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void limitedRequest(controller.signal, async () => thumbnailBody(await fetch(
      `/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content`,
      { cache: "no-store", signal: controller.signal }
    ))).then(html => {
      if (!controller.signal.aborted) setPreview({ versionId, html });
    }).catch(() => undefined).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [artifactId, eligible, versionId, visible]);
  return <span aria-hidden="true" inert className="v2-artifact-thumbnail" ref={target}>
    {eligible && visible && preview?.versionId === versionId
      ? <iframe aria-hidden="true" inert className="v2-artifact-thumbnail-frame" sandbox="" srcDoc={preview.html}
          tabIndex={-1} title="Artifact thumbnail" onError={() => setPreview(null)} />
      : <UiV2Icon name={artifactKindIcon(kind)} />}
  </span>;
}
