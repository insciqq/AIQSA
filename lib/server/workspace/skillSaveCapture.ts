import type { WorkspaceCoordinatorRepository } from "./coordinator";
import type { WorkspaceSelectedFile } from "./outputManifest";
import type { AcceptedWorkspaceSecret } from "./secrets/store";
import type { createWorkspaceSelectedCaptures } from "./selectedCapture";

export type SkillSaveCapturedFile = Readonly<{
  /** `<root>/<relative path>` as the capture names it. */
  relativePath: string;
  byteSize: number;
  /** Null when the file exceeds the reader's byte bound; it is never read then. */
  bytes: Buffer | null;
}>;

/** Workspace reads of a chat Skill save, under the run's current Workspace authority. */
export type SkillSaveWorkspaceReader = Readonly<{
  /**
   * One coherent capture of exactly these regular files (path escapes,
   * symlinks, special files and concurrent writers fail closed), read and
   * released. Files above `maxFileBytes` are listed but not read.
   */
  read(input: Readonly<{
    runId: string; userId: string; consumerKey: string; files: readonly WorkspaceSelectedFile[]; maxFileBytes: number;
    signal?: AbortSignal;
  }>): Promise<readonly SkillSaveCapturedFile[]>;
  /** The personal secrets delivered to this run's Workspace; never leaves the server. */
  secrets(input: Readonly<{ runId: string; userId: string }>): Promise<readonly AcceptedWorkspaceSecret[]>;
}>;

export function createSkillSaveWorkspaceReader(deps: Readonly<{
  captures: ReturnType<typeof createWorkspaceSelectedCaptures>;
  repository: Pick<WorkspaceCoordinatorRepository, "binding" | "personalSecrets">;
}>): SkillSaveWorkspaceReader {
  return {
    async read(input) {
      const consumer = { runId: input.runId, userId: input.userId, consumerKey: input.consumerKey };
      const capture = await deps.captures.create({ ...consumer, requestKey: input.consumerKey, files: input.files, signal: input.signal });
      const reference = { ...consumer, captureId: capture.id };
      try {
        const files: SkillSaveCapturedFile[] = [];
        for (const file of capture.files) {
          input.signal?.throwIfAborted();
          if (file.byteSize > input.maxFileBytes) {
            files.push({ relativePath: file.relativePath, byteSize: file.byteSize, bytes: null });
            continue;
          }
          const body = await deps.captures.openFile({ ...reference, relativePath: file.relativePath, signal: input.signal });
          const bytes = Buffer.from(await new Response(body).arrayBuffer());
          if (bytes.length !== file.byteSize) throw new Error("skill_save_capture_incomplete");
          files.push({ relativePath: file.relativePath, byteSize: file.byteSize, bytes });
        }
        return files;
      } finally {
        await deps.captures.release(reference).catch(() => undefined);
      }
    },
    async secrets(input) {
      const binding = await deps.repository.binding(input);
      if (!binding) throw new Error("skill_save_workspace_unavailable");
      return deps.repository.personalSecrets(binding);
    }
  };
}

export async function defaultSkillSaveWorkspaceReader(): Promise<SkillSaveWorkspaceReader> {
  const [{ prisma }, { createS3StorageAdapter }, { workspaceConfig, workspaceRuntime }, { createWorkspaceSelectedCaptures },
    { createPrismaWorkspaceCoordinatorRepository }] = await Promise.all([
    import("../prisma"), import("../uploads/storage"), import("./defaultServices"), import("./selectedCapture"), import("./coordinator")
  ]);
  return createSkillSaveWorkspaceReader({
    captures: createWorkspaceSelectedCaptures({ prisma, storage: createS3StorageAdapter(),
      config: workspaceConfig, runtime: workspaceRuntime }),
    repository: createPrismaWorkspaceCoordinatorRepository(prisma)
  });
}
