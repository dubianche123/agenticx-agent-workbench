/**
 * Filled deliverable cards under the assistant reply.
 * Download, copy-path and reveal live inside the tile so nothing overlays
 * the message below.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, CloudDownload, Copy, Eye, FolderOpen, Loader2, Undo2 } from "lucide-react";
import { HoverTip } from "../ds/HoverTip";
import { artifactGlyph, FileTypeMark } from "./artifact-glyph";
import {
  artifactBaseName,
  artifactExt,
  orderTurnArtifactsForCard,
} from "../../utils/session-artifacts";
import type { SessionTurn, SessionTurnArtifact } from "../../utils/session-turns";
import { formatPreviewBytes } from "../workspace/workspace-preview-types";

/** Cards shown before the grid collapses behind a single expander. */
const GRID_LIMIT = 4;

type Props = {
  paths: string[];
  onOpenPath?: (path: string) => void;
  onOpenAllArtifacts?: () => void;
  onOpenAllChanges?: () => void;
  /** Session-wide artifact total for「查看所有产物」; chips still use `paths`. */
  artifactCount?: number;
  /** Session-wide change total for「查看所有变更」. */
  changeCount?: number;
  /** Optional manifest metadata; file stat remains the live source when available. */
  artifactMeta?: SessionTurnArtifact[];
  /** Latest recoverable server turn; document-only turns place one undo action here. */
  undoTurn?: SessionTurn | null;
  onUndoTurn?: (turnId: string) => void | Promise<void>;
  undoingTurn?: boolean;
  undoError?: string | null;
};

type SaveAsDesktop = NonNullable<typeof window.agenticxDesktop> & {
  copyLocalFileAs?: (request: { sourcePath: string }) => Promise<{ ok: boolean; error?: string }>;
};

function TileAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <HoverTip label={label} tooltipAlign="end">
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted outline-none transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-text-strong focus-visible:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] active:scale-[0.94]"
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
    </HoverTip>
  );
}

export function TurnArtifactCard({
  paths,
  onOpenPath,
  onOpenAllArtifacts,
  onOpenAllChanges,
  artifactCount,
  changeCount,
  artifactMeta,
  undoTurn,
  onUndoTurn,
  undoingTurn = false,
  undoError,
}: Props) {
  const ordered = orderTurnArtifactsForCard(paths);
  const [expanded, setExpanded] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [sizeByPath, setSizeByPath] = useState<Record<string, number>>({});
  const extraCount = Math.max(0, ordered.length - GRID_LIMIT);
  const visible = extraCount === 0 || expanded ? ordered : ordered.slice(0, GRID_LIMIT);
  const singleTile = ordered.length === 1;

  useEffect(() => {
    const stat = window.agenticxDesktop?.statLocalPath;
    if (!stat) return;
    let cancelled = false;
    void Promise.all(
      ordered.map(async (path) => {
        try {
          const result = await stat(path);
          if (result.ok && !result.isDirectory && typeof result.size === "number") {
            return [path, result.size] as const;
          }
        } catch {
          /* Metadata is optional. */
        }
        return null;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSizeByPath(
        Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => entry != null)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ordered.join("\0")]);

  if (ordered.length === 0) return null;

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath(null), 1600);
    } catch {
      /* ignore */
    }
  };

  const revealInFolder = async (path: string) => {
    const reveal = window.agenticxDesktop?.shellShowItemInFolder;
    if (!reveal) return;
    const result = await reveal(path);
    if (!result.ok) console.warn("[TurnArtifactCard] reveal failed:", result.error);
  };

  const saveAs = async (path: string) => {
    const desktop = window.agenticxDesktop as SaveAsDesktop | undefined;
    const api = desktop?.copyLocalFileAs;
    if (typeof api !== "function") return;
    try {
      const result = await api({ sourcePath: path });
      if (!result.ok && result.error) {
        console.warn("[TurnArtifactCard] save-as failed:", result.error);
      }
    } catch (err) {
      console.warn("[TurnArtifactCard] save-as failed:", err);
    }
  };

  return (
    <div className="agx-artifact-cq w-full min-w-0">
      <div
        className={`agx-artifact-grid grid w-full min-w-0 gap-2${ordered.length > 1 ? " agx-artifact-grid--multi sm:grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))]" : " agx-artifact-grid--single"}`}
      >
        {visible.map((path) => {
          const manifestArtifact = artifactMeta?.find((artifact) => artifact.path === path);
          const name = artifactBaseName(path) || manifestArtifact?.title || path;
          const title = manifestArtifact?.title && manifestArtifact.title !== name
            ? manifestArtifact.title
            : "";
          const size = sizeByPath[path] != null
            ? formatPreviewBytes(sizeByPath[path])
            : manifestArtifact?.size != null
              ? formatPreviewBytes(manifestArtifact.size)
              : "";
          const extension = artifactExt(path).toUpperCase() || "文件";
          const meta = size || extension;
          const { kind } = artifactGlyph(path);
          const copied = copiedPath === path;
          return (
            <article
              key={path}
              className={`agx-artifact-tile flex min-w-0 items-center gap-3 rounded-2xl border border-border bg-surface-popover px-4 py-3.5 shadow-sm transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-px hover:border-border-strong hover:bg-surface-hover ${
                singleTile ? "w-max max-w-full min-w-0 sm:min-w-[18rem]" : "w-full justify-between gap-2"
              }`}
              data-artifact-path={path}
            >
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-3 text-left outline-none transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:ring-1 focus-visible:ring-border active:scale-[0.99] ${
                  singleTile ? "" : "flex-1"
                }`}
                title={path}
                onClick={() => (onOpenPath ? onOpenPath(path) : undefined)}
                aria-label={`预览 ${name}`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-card">
                  <span className="flex h-5 w-5 items-center justify-center">
                    <FileTypeMark kind={kind} />
                  </span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5 pr-1">
                  <span className="min-w-0 truncate text-[14px] font-semibold leading-tight text-text-strong">
                    {name}
                  </span>
                  {title ? (
                    <span className="min-w-0 truncate text-[11.5px] leading-none text-text-muted" title={title}>
                      {title}
                    </span>
                  ) : null}
                  <span className="flex min-w-0 items-center gap-2 text-[11.5px] leading-none text-text-faint">
                    {meta}
                    {size ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">{extension}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="inline-flex w-fit items-center gap-1 text-[11.5px] font-medium text-text-muted">
                    <Eye className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                    预览
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center">
                <TileAction label={`另存为 ${name}`} onClick={() => void saveAs(path)}>
                  <CloudDownload className="h-[16px] w-[16px]" strokeWidth={1.5} />
                </TileAction>
                <TileAction
                  label={copied ? "已复制路径" : `复制路径 ${name}`}
                  onClick={() => void copyPath(path)}
                >
                  {copied ? (
                    <Check className="h-[16px] w-[16px] text-emerald-400" strokeWidth={2} />
                  ) : (
                    <Copy className="h-[16px] w-[16px]" strokeWidth={1.5} />
                  )}
                </TileAction>
                <TileAction label={`在文件夹中显示 ${name}`} onClick={() => void revealInFolder(path)}>
                  <FolderOpen className="h-[16px] w-[16px]" strokeWidth={1.5} />
                </TileAction>
              </div>
            </article>
          );
        })}
      </div>
      {onOpenAllArtifacts || onOpenAllChanges || (undoTurn?.canUndo && onUndoTurn) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {onOpenAllArtifacts ? (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-md py-0.5 text-[12px] text-text-muted transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-text-primary active:scale-[0.98]"
              onClick={onOpenAllArtifacts}
            >
              查看所有产物 ({artifactCount ?? ordered.length})
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            </button>
          ) : null}
          {onOpenAllChanges ? (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-md py-0.5 text-[12px] text-text-muted transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-text-primary active:scale-[0.98]"
              onClick={onOpenAllChanges}
            >
              查看所有变更 ({changeCount ?? ordered.length})
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            </button>
          ) : null}
          {undoTurn?.canUndo && onUndoTurn ? (
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border bg-surface-card px-2.5 py-1 text-[12px] font-medium text-text-primary transition-[background-color,color,transform] duration-150 hover:bg-surface-hover hover:text-text-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55"
              disabled={undoingTurn}
              onClick={() => void onUndoTurn(undoTurn.turnId)}
              aria-label="撤回本轮修改"
            >
              {undoingTurn ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Undo2 className="h-3.5 w-3.5" aria-hidden />}
              撤回本轮修改
            </button>
          ) : null}
        </div>
      ) : extraCount > 0 ? (
        <button
          type="button"
          className="mt-1.5 rounded-md px-0.5 py-0.5 text-left text-[11.5px] text-text-muted transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-text-primary active:scale-[0.98]"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "收起产物" : `查看全部 ${ordered.length} 个产物`}
        </button>
      ) : null}
      {undoError ? (
        <p className="mt-1 min-w-0 break-words text-[11px] leading-relaxed text-status-error" role="alert">
          {undoError}
        </p>
      ) : null}
    </div>
  );
}
