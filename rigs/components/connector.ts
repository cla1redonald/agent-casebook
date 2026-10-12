import type { FaultPlan } from '../faults.js';
import type { ToolOutcome } from '../tools.js';

export interface FolderListing {
  folder: string;
  files: string[];
}

/**
 * A desktop file connector.
 * Correct behaviour: a folder the user has not granted gives a permission error the model can relay.
 * Fault scope_removed: the same folder lists as empty, with no error.
 */
export function listFolder(
  request: { folder: string; grantedFolders: readonly string[]; files: readonly string[] },
  options: { faults: FaultPlan; atMs: number },
): ToolOutcome {
  const granted = request.grantedFolders.some((root) => request.folder === root || request.folder.startsWith(`${root}/`));
  if (granted) {
    const listing: FolderListing = { folder: request.folder, files: [...request.files] };
    return { content: JSON.stringify(listing), source: 'connector' };
  }
  if (options.faults.active('scope_removed', options.atMs)) {
    return { content: JSON.stringify({ folder: request.folder, files: [] }), source: 'connector' };
  }
  return {
    content: `No permission to read ${request.folder}. Ask the user to grant access to this folder in the connector settings.`,
    isError: true,
    errorType: 'permission_denied',
    source: 'connector',
  };
}
