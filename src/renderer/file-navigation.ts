import type { DesktopApi, Snapshot } from "../bridge/index.js";

/** Legacy links always browse the project; discard navigation if its scope changed. */
export async function prepareFileNavigation(
  api: Pick<DesktopApi, "snapshot">,
  scope: Pick<Snapshot, "database" | "directory">,
  _root?: string,
): Promise<Snapshot | null> {
  if (!scope.directory) throw new Error("Open a project to browse files.");
  const latest = await api.snapshot();
  // A delayed read must not navigate a different project or database.
  if (latest.database !== scope.database || latest.directory !== scope.directory) return null;
  return latest;
}
