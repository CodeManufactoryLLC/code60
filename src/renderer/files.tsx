import { hotkeysCoreFeature, syncDataLoaderFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApi, FileContext, FileEntry, Snapshot } from "../bridge/index.js";
import { Icon } from "./icons.js";
import { pathLabel } from "./path-label.js";

const MonacoPreview = lazy(() => import("./monaco-preview.js"));
const rootId = "/";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function useFiles(api: DesktopApi, snapshot: Snapshot | undefined, active: boolean) {
  const project = snapshot?.directory ?? null;
  const workspace = `${snapshot?.database}:${project}`;
  const [selection, setSelection] = useState<{
    workspace: string;
    root: string;
    preview: string | null;
  }>();
  const [expansions, setExpansions] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [revealSerial, setRevealSerial] = useState(0);
  const [selectionWorkspace, setSelectionWorkspace] = useState(workspace);
  if (selectionWorkspace !== workspace) {
    setSelectionWorkspace(workspace);
    setSelection(undefined);
    setError("");
  }
  const root = selection?.workspace === workspace ? selection.root : project;
  const preview = selection?.workspace === workspace ? selection.preview : null;
  const expansionKey = JSON.stringify([workspace, root]);
  const expanded = expansions[expansionKey] ?? [];
  const context: FileContext | null =
    project && root
      ? {
          project,
          root,
          directories: [
            "",
            ...expanded.filter((path) => {
              const parts = path.split("/");
              return parts
                .slice(0, -1)
                .every((_, index) => expanded.includes(parts.slice(0, index + 1).join("/")));
            }),
          ],
          preview,
        }
      : null;
  const requestJson = JSON.stringify({
    workspace,
    context: active ? context : null,
  });
  useEffect(() => {
    let current = true;
    setError("");
    void api
      .setFileContext((JSON.parse(requestJson) as { context: FileContext | null }).context)
      .catch((cause) => {
        if (current) setError(message(cause));
      });
    return () => {
      current = false;
    };
  }, [api, requestJson]);
  const files =
    snapshot?.files?.context.project === project && snapshot.files.context.root === root
      ? snapshot.files
      : null;
  const roots = project ? [{ path: project, label: `Project · ${pathLabel(project)}` }] : [];
  const selectRoot = (_next?: string) => {
    if (project) setSelection({ workspace, root: project, preview: null });
  };
  const selectFile = (path: string | null) => {
    if (root) setSelection({ workspace, root, preview: path });
  };
  const setExpanded = (next: string[] | ((previous: string[]) => string[])) => {
    const paths = typeof next === "function" ? next(expanded) : next;
    if (paths.length > 63) {
      setError("Folder limit reached. Collapse a folder before expanding another.");
      return;
    }
    setError("");
    setExpansions((previous) => ({ ...previous, [expansionKey]: paths }));
  };
  const reveal = () => {
    if (preview === null) return;
    const parts = preview.split("/");
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    setExpanded([...new Set([...ancestors, ...expanded])].slice(0, 63));
    setRevealSerial((serial) => serial + 1);
  };
  return {
    root,
    preview,
    reveal,
    revealSerial,
    expanded,
    setExpanded,
    files,
    roots,
    selectRoot,
    selectFile,
    error:
      error || snapshot?.polling.sources.find((source) => source.key === "files")?.lastError || "",
    loading:
      snapshot?.polling.sources.find((source) => source.key === "files")?.status === "polling",
    workspace,
  };
}
export type FileBrowser = ReturnType<typeof useFiles>;

export function FilesPage({
  browser,
  onOpenProject,
}: {
  browser: FileBrowser;
  onOpenProject(): void;
}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (browser.revealSerial && browser.preview?.split("/").some((part) => part.startsWith(".")))
      setHidden(true);
  }, [browser.revealSerial, browser.preview]);
  return (
    <section className="files-page" aria-label="File Explorer">
      <header className="files-header">
        <h2>File Explorer</h2>
        {browser.root && (
          <div className="files-controls">
            <label>
              Root
              <select
                aria-label="File root"
                value={browser.root}
                onChange={(event) => browser.selectRoot(event.target.value)}
              >
                {!browser.roots.some((root) => root.path === browser.root) && (
                  <option value={browser.root}>Unavailable · {browser.root}</option>
                )}
                {browser.roots.map((root) => (
                  <option key={root.path} value={root.path}>
                    {root.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="files-hidden">
              <input
                type="checkbox"
                checked={hidden}
                onChange={(event) => setHidden(event.target.checked)}
              />
              Show hidden files
            </label>
          </div>
        )}
      </header>
      {!browser.root && (
        <div className="files-status">
          <p>Open a project to browse files.</p>
          <button type="button" onClick={onOpenProject}>
            Open project
          </button>
        </div>
      )}
      {browser.error && (
        <p className="error-banner" role="alert">
          {browser.error}
        </p>
      )}
      {browser.root && (
        <FileTree key={`${browser.workspace}:${browser.root}`} browser={browser} hidden={hidden} />
      )}
    </section>
  );
}

function FileTree({ browser, hidden }: { browser: FileBrowser; hidden: boolean }) {
  const entries = useMemo(
    () =>
      new Map(
        (browser.files?.directories ?? []).flatMap((dir) =>
          dir.entries.map((entry) => [entry.path, entry] as const),
        ),
      ),
    [browser.files],
  );
  const tree = useTree<FileEntry>({
    rootItemId: rootId,
    state: { expandedItems: browser.expanded },
    setExpandedItems: browser.setExpanded,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind === "directory",
    dataLoader: {
      getItem: (id) => entries.get(id) ?? { path: id, name: id, kind: "directory" },
      getChildren: (id) =>
        (
          browser.files?.directories.find((dir) => dir.path === (id === rootId ? "" : id))
            ?.entries ?? []
        )
          .filter((entry) => hidden || !entry.name.startsWith("."))
          .map((entry) => entry.path),
    },
    onPrimaryAction: (item) => {
      if (item.getItemData().kind === "file") browser.selectFile(item.getId());
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });
  // Headless Tree caches its flattened structure; external listings and filters invalidate it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These inputs change the configured synchronous data loader.
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, browser.files, hidden]);
  const revealed = useRef(0);
  useEffect(() => {
    if (
      !browser.preview ||
      !entries.has(browser.preview) ||
      revealed.current === browser.revealSerial
    )
      return;
    const item = tree.getItems().find((item) => item.getId() === browser.preview);
    const element = item?.getElement();
    if (!element) return;
    item?.setFocused();
    element.focus();
    element.scrollIntoView({ block: "nearest" });
    revealed.current = browser.revealSerial;
  }, [tree, browser.preview, browser.revealSerial, entries]);
  const issues = browser.files?.directories.filter((dir) => dir.error || dir.truncated) ?? [];
  return (
    <>
      {browser.loading && (
        <p className="files-status" role="status">
          Loading files…
        </p>
      )}
      {issues.map((dir) => (
        <p className="files-status" role="status" key={dir.path}>
          {dir.path || "/"}: {dir.error ?? "Folder listing limit reached."}
        </p>
      ))}
      <div {...tree.getContainerProps("Project files")} className="file-tree">
        {tree.getItems().map((item) => (
          <button
            {...item.getProps()}
            role="treeitem"
            type="button"
            key={item.getId()}
            className="file-tree-item"
            style={{ paddingLeft: 12 + item.getItemMeta().level * 18 }}
            aria-selected={browser.preview === item.getId()}
            aria-disabled={!["directory", "file"].includes(item.getItemData().kind)}
          >
            <Icon
              name={
                item.isFolder()
                  ? item.isExpanded()
                    ? "chevron--down"
                    : "chevron--right"
                  : "document"
              }
            />
            <span>{item.getItemName()}</span>
            {item.getItemData().kind === "symlink" && <span className="muted">Symbolic link</span>}
            {item.getItemData().kind === "other" && <span className="muted">Unsupported file</span>}
          </button>
        ))}
      </div>
      {browser.files && !browser.loading && tree.getItems().length === 0 && issues.length === 0 && (
        <p className="files-status">No files.</p>
      )}
    </>
  );
}

export function FileInspector({ browser, onReveal }: { browser: FileBrowser; onReveal(): void }) {
  const [width, setWidth] = useState(440);
  const path = browser.preview;
  if (path === null) return null;
  const preview = browser.files?.preview?.path === path ? browser.files.preview : null;
  const resize = (value: number) => setWidth(Math.max(300, Math.min(800, value)));
  return (
    <aside className="file-inspector" aria-label="File preview" style={{ width }}>
      <button
        type="button"
        className="file-inspector-resize"
        aria-label="Resize file preview"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resize(width + (event.key === "ArrowLeft" ? 20 : -20));
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const parent = event.currentTarget.parentElement;
          if (parent && event.currentTarget.hasPointerCapture(event.pointerId))
            resize(parent.getBoundingClientRect().right - event.clientX);
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      />
      <header className="file-inspector-header">
        <h2>{path.split("/").at(-1)}</h2>
        <div className="button-group">
          <button type="button" onClick={onReveal}>
            Reveal in Files
          </button>
          <button
            type="button"
            aria-label="Close file preview"
            onClick={() => browser.selectFile(null)}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="file-inspector-context">
        <span>
          {browser.roots.find((root) => root.path === browser.root)?.label ?? browser.root}
        </span>
        <code>{path}</code>
      </div>
      {preview && (
        <details className="file-metadata">
          <summary>File information</summary>
          <dl>
            <dt>Size</dt>
            <dd>{preview.size === null ? "Unknown" : `${preview.size.toLocaleString()} bytes`}</dd>
            <dt>Modified</dt>
            <dd>
              {preview.modifiedAt ? new Date(preview.modifiedAt).toLocaleString() : "Unknown"}
            </dd>
            <dt>Mode</dt>
            <dd>Read-only</dd>
          </dl>
        </details>
      )}
      {browser.error || preview?.error ? (
        <p className="error-banner" role="alert">
          {browser.error || preview?.error}
        </p>
      ) : preview?.text !== null && preview?.text !== undefined ? (
        <Suspense
          fallback={
            <p className="files-status" role="status">
              Loading preview…
            </p>
          }
        >
          <MonacoPreview text={preview.text} path={path} />
        </Suspense>
      ) : (
        <p className="files-status" role="status">
          Loading preview…
        </p>
      )}
    </aside>
  );
}
