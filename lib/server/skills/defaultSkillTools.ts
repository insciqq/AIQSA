import { prisma } from "../prisma";
import { createSkillCatalogRepository } from "./catalogRepository";
import { createSkillToolService } from "./toolService";

export const defaultSkillTools = createSkillToolService({
  resolveFrozen: createSkillCatalogRepository(prisma).resolveFrozen,
  async isLoaded({ runId, skillId }) {
    return await prisma.modelRunSkillBinding.count({ where: { modelRunId: runId, skillId } }) > 0;
  },
  async readText({ revisionId, path }) {
    const file = await prisma.skillRevisionFile.findUnique({
      where: { revisionId_path: { revisionId, path } }, select: { textContent: true }
    });
    return file?.textContent ?? null;
  }
});
