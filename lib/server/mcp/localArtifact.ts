import type { McpJsonObject, McpSource } from "@/lib/contracts/mcp";
import { TOOLHIVE_EXPECTED_VERSION } from "./toolhiveClient";

const OCI_DIGEST_REFERENCE = /^\S+@sha256:[a-f0-9]{64}$/u;
const TOOLHIVE_LOCAL_IMAGE = /^toolhivelocal\/[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/u;

export type McpLocalResolvedArtifact = Readonly<{
  exactVersion?: string;
  imageRef: string;
  imageReferenceKind: "oci_digest" | "toolhive_generated_tag";
  kind: "toolhive_local";
  materializer: "npx" | "oci" | "uvx";
  packageName?: string;
  registryArtifactUrl?: string;
  registryIntegrity?: string;
  sourceKind: "npm" | "oci" | "pypi";
  toolhiveVersion: typeof TOOLHIVE_EXPECTED_VERSION;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDigestPinnedOciImage(image: string): boolean {
  return OCI_DIGEST_REFERENCE.test(image);
}

export function isToolHiveGeneratedImage(image: string): boolean {
  return TOOLHIVE_LOCAL_IMAGE.test(image);
}

export function localResolvedArtifactJson(
  artifact: McpLocalResolvedArtifact
): McpJsonObject {
  return { ...artifact };
}

export function parseMcpLocalResolvedArtifact(
  value: unknown,
  source: McpSource
): McpLocalResolvedArtifact | null {
  if (!isRecord(value) || value.kind !== "toolhive_local" ||
    value.toolhiveVersion !== TOOLHIVE_EXPECTED_VERSION ||
    typeof value.sourceKind !== "string" || typeof value.materializer !== "string" ||
    typeof value.imageRef !== "string" || typeof value.imageReferenceKind !== "string") return null;

  if (source.kind === "oci") {
    if (value.sourceKind !== "oci" || value.materializer !== "oci" ||
      value.imageReferenceKind !== "oci_digest" || value.imageRef !== source.image ||
      !isDigestPinnedOciImage(value.imageRef)) return null;
    return {
      imageRef: value.imageRef,
      imageReferenceKind: "oci_digest",
      kind: "toolhive_local",
      materializer: "oci",
      sourceKind: "oci",
      toolhiveVersion: TOOLHIVE_EXPECTED_VERSION
    };
  }

  if (source.kind !== "npm" && source.kind !== "pypi") return null;
  const expectedMaterializer = source.kind === "npm" ? "npx" : "uvx";
  if (value.sourceKind !== source.kind || value.materializer !== expectedMaterializer ||
    value.imageReferenceKind !== "toolhive_generated_tag" ||
    value.packageName !== source.packageName || typeof value.exactVersion !== "string" ||
    !value.exactVersion || typeof value.registryIntegrity !== "string" ||
    !value.registryIntegrity || typeof value.registryArtifactUrl !== "string" ||
    !value.registryArtifactUrl || !isToolHiveGeneratedImage(value.imageRef)) return null;
  try {
    const artifactUrl = new URL(value.registryArtifactUrl);
    if (artifactUrl.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (source.kind === "npm" && !/^(?:sha(?:1|256|384|512)-[A-Za-z0-9+/=]+|sha1:[a-f0-9]{40})$/u
    .test(value.registryIntegrity)) return null;
  if (source.kind === "pypi" && !/^sha256:[a-f0-9]{64}$/u.test(value.registryIntegrity)) return null;

  return {
    exactVersion: value.exactVersion,
    imageRef: value.imageRef,
    imageReferenceKind: "toolhive_generated_tag",
    kind: "toolhive_local",
    materializer: expectedMaterializer,
    packageName: source.packageName,
    registryArtifactUrl: value.registryArtifactUrl,
    registryIntegrity: value.registryIntegrity,
    sourceKind: source.kind,
    toolhiveVersion: TOOLHIVE_EXPECTED_VERSION
  };
}
