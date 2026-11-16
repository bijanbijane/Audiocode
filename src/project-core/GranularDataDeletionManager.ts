import { AssetId } from '../contracts/storage-broker.contract';
import { ProjectDocument } from '../contracts/project-schema.contract';

export type GranularDeletionScope =
  | 'REMOVE_ASSET_REFERENCE_FROM_PROJECT'
  | 'DELETE_DERIVED_RENDERS'
  | 'DELETE_SOURCE_ASSET_FILE'
  | 'PURGE_PCM_AND_GRAPH_CACHE'
  | 'DELETE_AI_ANALYSIS_RESULTS'
  | 'CLEAR_EDIT_TRANSACTION_HISTORY'
  | 'UNINSTALL_LOCAL_AI_MODEL'
  | 'FULL_PROJECT_DELETION';

export interface OpfsDirectoryLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * 8-Level Independent Granular Data Deletion Manager (Architecture Doc Section 49).
 * Prevents deleting shared source assets referenced by other local projects.
 */
export class GranularDataDeletionManager {
  public static findDependentProjectsForAsset(
    targetAssetId: AssetId,
    currentProjectId: string,
    allLocalProjects: ProjectDocument[],
  ): string[] {
    const dependentProjectIds: string[] = [];

    for (const proj of allLocalProjects) {
      if (proj.projectId === currentProjectId) continue;
      const usesAsset = proj.tracks.some((track) =>
        track.clips.some((clip) => clip.assetId === targetAssetId),
      );
      if (usesAsset) {
        dependentProjectIds.push(proj.projectId);
      }
    }

    return dependentProjectIds;
  }

  public static async executeGranularDeletion(params: {
    scope: GranularDeletionScope;
    targetProject: ProjectDocument;
    allLocalProjects: ProjectDocument[];
    targetAssetId?: AssetId;
    targetModelIdAndVersion?: string;
    opfsRoot: OpfsDirectoryLike;
  }): Promise<{
    deletedScope: GranularDeletionScope;
    updatedProject: ProjectDocument | null;
    freedDiskEntities: string[];
  }> {
    const { scope, targetProject, allLocalProjects, targetAssetId, opfsRoot } = params;
    const freedDiskEntities: string[] = [];

    switch (scope) {
      case 'REMOVE_ASSET_REFERENCE_FROM_PROJECT': {
        if (!targetAssetId) throw new Error('MISSING_TARGET_ASSET_ID');
        const updatedTracks = targetProject.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => c.assetId !== targetAssetId),
        }));
        return {
          deletedScope: scope,
          updatedProject: {
            ...targetProject,
            revision: targetProject.revision + 1,
            tracks: updatedTracks,
          },
          freedDiskEntities: [],
        };
      }

      case 'DELETE_DERIVED_RENDERS': {
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'derived-renders',
          targetProject.projectId,
          true,
        );
        freedDiskEntities.push(`derived-renders/${targetProject.projectId}`);
        return {
          deletedScope: scope,
          updatedProject: targetProject,
          freedDiskEntities,
        };
      }

      case 'DELETE_SOURCE_ASSET_FILE': {
        if (!targetAssetId) throw new Error('MISSING_TARGET_ASSET_ID');
        const dependents = this.findDependentProjectsForAsset(
          targetAssetId,
          targetProject.projectId,
          allLocalProjects,
        );
        if (dependents.length > 0) {
          throw new Error(
            `ASSET_IN_USE_BY_OTHER_PROJECTS: فایل صوتی موردنظر در پروژه‌های دیگر (${dependents.join(', ')}) در حال استفاده است و نمی‌تواند از دیسک حذف شود.`,
          );
        }

        await this.safeRemoveDirectoryEntry(opfsRoot, 'assets', `${targetAssetId}.bin`);
        freedDiskEntities.push(`assets/${targetAssetId}.bin`);

        const updatedTracks = targetProject.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => c.assetId !== targetAssetId),
        }));
        return {
          deletedScope: scope,
          updatedProject: {
            ...targetProject,
            revision: targetProject.revision + 1,
            tracks: updatedTracks,
          },
          freedDiskEntities,
        };
      }

      case 'PURGE_PCM_AND_GRAPH_CACHE': {
        await opfsRoot.removeEntry('pcm-lru-cache', { recursive: true }).catch(() => {});
        await opfsRoot.getDirectoryHandle('pcm-lru-cache', { create: true });
        freedDiskEntities.push('pcm-lru-cache/*');
        return {
          deletedScope: scope,
          updatedProject: targetProject,
          freedDiskEntities,
        };
      }

      case 'DELETE_AI_ANALYSIS_RESULTS': {
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'ai-analysis-cache',
          `${targetProject.projectId}.json`,
        );
        return {
          deletedScope: scope,
          updatedProject: {
            ...targetProject,
            revision: targetProject.revision + 1,
            recommendations: [],
          },
          freedDiskEntities: [
            'project_ai_analysis_state',
            `ai-analysis-cache/${targetProject.projectId}.json`,
          ],
        };
      }

      case 'CLEAR_EDIT_TRANSACTION_HISTORY': {
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'transaction-history',
          `${targetProject.projectId}.journal.json`,
        );
        freedDiskEntities.push(`transaction-history/${targetProject.projectId}.journal.json`);
        return {
          deletedScope: scope,
          updatedProject: targetProject,
          freedDiskEntities,
        };
      }

      case 'UNINSTALL_LOCAL_AI_MODEL': {
        if (!params.targetModelIdAndVersion) throw new Error('MISSING_MODEL_ID');
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'ai-models',
          params.targetModelIdAndVersion,
          true,
        );
        freedDiskEntities.push(`ai-models/${params.targetModelIdAndVersion}`);
        return {
          deletedScope: scope,
          updatedProject: targetProject,
          freedDiskEntities,
        };
      }

      case 'FULL_PROJECT_DELETION': {
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'recovery-journal',
          `${targetProject.projectId}.checkpoint.json`,
        );
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'derived-renders',
          targetProject.projectId,
          true,
        );
        await this.safeRemoveDirectoryEntry(
          opfsRoot,
          'transaction-history',
          `${targetProject.projectId}.journal.json`,
        );
        freedDiskEntities.push(`project:${targetProject.projectId}`);
        return {
          deletedScope: scope,
          updatedProject: null,
          freedDiskEntities,
        };
      }
    }
  }

  private static async safeRemoveDirectoryEntry(
    root: OpfsDirectoryLike,
    subDirName: string,
    entryName: string,
    recursive = false,
  ): Promise<void> {
    try {
      const dir = await root.getDirectoryHandle(subDirName, { create: false });
      await dir.removeEntry(entryName, { recursive });
    } catch {
      // Idempotent deletion when entry or directory does not exist
    }
  }
}
