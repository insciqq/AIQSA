export type GeneratedArtifactFormat = "docx" | "pdf" | "pptx" | "xlsx";

export type GeneratedArtifactEventKind =
  | "generated_file_detected"
  | "generated_file_failed"
  | "generated_file_ready"
  | "generated_file_rendering"
  | "generated_file_validating";

export type GeneratedArtifactLifecycleEvent = Readonly<{
  kind: GeneratedArtifactEventKind;
  state: "active" | "complete" | "failed" | "pending";
}>;

export type GeneratedArtifactTablePreview = Readonly<{
  activeTab: string;
  kind: "table";
  tabs: readonly Readonly<{
    columns: readonly string[];
    label: string;
    rows: readonly (readonly string[])[];
  }>[];
}>;

export type GeneratedArtifactPagePreview = Readonly<{
  activePage: number;
  kind: "pages" | "slides";
  lines: readonly string[];
  pageCount: number;
  title: string;
}>;

export type GeneratedArtifactPreview =
  | Readonly<{
      content: GeneratedArtifactPagePreview | GeneratedArtifactTablePreview;
      status: "ready";
    }>
  | Readonly<{
      reason: string;
      status: "failed";
    }>
  | Readonly<{
      status: "pending" | "rendering";
    }>;

export type GeneratedArtifactVersion = Readonly<{
  branchLabel: string;
  byteSize: number;
  createdAtLabel: string;
  downloadAvailable: boolean;
  format: GeneratedArtifactFormat;
  id: string;
  number: number;
  parentVersionNumber: number | null;
  preview: GeneratedArtifactPreview;
  sourceMessageId: string;
  sourceMessageLabel: string;
  structuralSummary: string;
  useInNextMessageAvailable: boolean;
}>;

type GeneratedArtifactBase = Readonly<{
  events: readonly GeneratedArtifactLifecycleEvent[];
  format: GeneratedArtifactFormat;
  id: string;
  logicalFileId: string;
  name: string;
}>;

export type GeneratedArtifactProjection =
  | (GeneratedArtifactBase & Readonly<{
      boundVersionId: null;
      status: "cancelled" | "generating";
      versions: readonly [];
    }>)
  | (GeneratedArtifactBase & Readonly<{
      boundVersionId: null;
      status: "failed";
      validationFailure: string;
      versions: readonly [];
    }>)
  | (GeneratedArtifactBase & Readonly<{
      boundVersionId: string;
      status: "ready";
      versions: readonly GeneratedArtifactVersion[];
    }>);
