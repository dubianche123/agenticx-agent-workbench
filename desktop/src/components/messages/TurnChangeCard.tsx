import { FileText, Loader2, Undo2 } from "lucide-react";
import { useState } from "react";
import {
  visibleSessionTurnArtifacts,
  visibleSessionTurnFiles,
  type SessionTurn,
} from "../../utils/session-turns";

export type TurnChangeCardProps = {
  turn: SessionTurn;
  onUndo: (turnId: string) => void | Promise<void>;
  undoing?: boolean;
  error?: string | null;
  onOpenArtifact?: (path: string) => void;
  /** Document-only turns render one recovery action without a duplicate diff table. */
  documentOnly?: boolean;
};

function changeLabel(change: string): string {
  switch (change) {
    case "added":
      return "新增";
    case "deleted":
      return "删除";
    case "modified":
      return "修改";
    case "unchanged":
      return "未变更";
    default:
      return change || "变更";
  }
}

function lineSummary(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join(" ");
}

export function TurnChangeCard({
  turn,
  onUndo,
  undoing = false,
  error,
  onOpenArtifact,
  documentOnly = false,
}: TurnChangeCardProps) {
  const [expanded, setExpanded] = useState(false);

  // A turn manifest can exist for legacy/metadata-only turns that have no
  // checkpoint to restore.  Keep the chat surface quiet in that case instead
  // of showing a disabled undo card with an empty file list.
  if (!turn.canUndo) return null;

  const files = visibleSessionTurnFiles(turn);
  const artifacts = visibleSessionTurnArtifacts(turn);
  if (files.length === 0 && artifacts.length === 0) return null;
  if (documentOnly) {
    return (
      <section
        className="mt-2 flex w-full max-w-[42rem] flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-card px-3 py-2.5 text-xs shadow-sm"
        data-session-turn-id={turn.turnId}
        aria-label="本轮文档变更"
      >
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-text-strong">
          <FileText size={14} aria-hidden />
          <span>文档变更</span>
        </div>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-card px-2.5 py-1 text-[12px] font-medium text-text-primary transition hover:bg-surface-hover hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-50"
          disabled={undoing}
          onClick={() => void onUndo(turn.turnId)}
          aria-label="撤回本轮修改"
        >
          {undoing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Undo2 size={13} aria-hidden />}
          撤回本轮修改
        </button>
        {error ? (
          <p className="basis-full min-w-0 break-words text-[11px] leading-relaxed text-status-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }
  const visibleFiles = expanded ? files : files.slice(0, 5);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);
  const hasVisibleContent = files.length > 0 || artifacts.length > 0;
  const unavailableReason = turn.canUndo ? null : turn.reason || "该轮没有可用的检查点，暂时无法撤回";

  return (
    <section
      className="mt-2 w-full max-w-[42rem] rounded-lg border border-border/70 bg-surface-card/75 px-3 py-2 text-xs shadow-sm"
      data-session-turn-id={turn.turnId}
      aria-label="本轮文件变更"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-text-strong">
          <FileText size={14} aria-hidden />
          <span>文件变更</span>
          {files.length > 0 ? <span className="text-text-faint">{files.length} 项</span> : null}
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted transition hover:bg-surface-hover hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!turn.canUndo || undoing}
          onClick={() => void onUndo(turn.turnId)}
          aria-label="撤回到此轮之前"
        >
          {undoing ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Undo2 size={12} aria-hidden />}
          撤回到此轮之前
        </button>
      </div>

      {hasVisibleContent ? (
        <div className="mt-1.5 space-y-1">
          {visibleFiles.map((file) => (
            <div key={`${file.path}:${file.change}`} className="flex min-w-0 items-center gap-2 text-text-muted">
              <span className="shrink-0 rounded bg-surface-hover px-1 py-0.5 text-[10px]">{changeLabel(file.change)}</span>
              <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
              {lineSummary(file.addedLines, file.removedLines) ? (
                <span className="shrink-0 font-mono text-[10px] text-text-faint">{lineSummary(file.addedLines, file.removedLines)}</span>
              ) : null}
            </div>
          ))}
          {hiddenFileCount > 0 ? (
            <button
              type="button"
              className="text-[11px] text-text-muted underline decoration-border underline-offset-2 hover:text-text-strong"
              onClick={() => setExpanded(true)}
            >
              展开其余 {hiddenFileCount} 项
            </button>
          ) : expanded && files.length > 5 ? (
            <button
              type="button"
              className="text-[11px] text-text-muted underline decoration-border underline-offset-2 hover:text-text-strong"
              onClick={() => setExpanded(false)}
            >
              收起
            </button>
          ) : null}
          {artifacts.length > 0 ? (
            <div className="border-t border-border/50 pt-1 text-text-faint">
              <span className="mr-1">产物：</span>
              {artifacts.map((artifact, index) => (
                <span key={artifact.path}>
                  {index > 0 ? "、" : null}
                  {onOpenArtifact ? (
                    <button
                      type="button"
                      className="truncate text-left text-text-muted underline decoration-border underline-offset-2 hover:text-text-strong"
                      onClick={() => onOpenArtifact(artifact.path)}
                      title={artifact.path}
                    >
                      {artifact.title}
                    </button>
                  ) : (
                    <span title={artifact.path}>{artifact.title}</span>
                  )}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-text-faint">本轮没有登记的成品文件</p>
      )}

      {unavailableReason ? <p className="mt-1 text-[11px] text-text-faint">{unavailableReason}</p> : null}
      {error ? (
        <p className="mt-1 min-w-0 break-words text-[11px] text-[var(--status-error)]" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
