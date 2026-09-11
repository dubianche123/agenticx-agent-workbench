import { useState } from "react";
import { LockKeyhole, ShieldAlert, X } from "lucide-react";

import type { RoutingModelRef } from "../utils/attachment-routing";

export type AttachmentRoutingStatus =
  | {
      kind: "locked" | "pending-private" | "pending-choice";
      target: RoutingModelRef;
      title: string;
      description: string;
    }
  | null;

export function attachmentRoutingStatusIdentity(
  scopeKey: string,
  status: Exclude<AttachmentRoutingStatus, null>,
): string {
  return `${scopeKey}:${status.kind}:${status.target.id}`;
}

export function resolveAttachmentRoutingStatus({
  lockedTarget,
  pendingTarget,
  pendingAllowsPublic = false,
}: {
  lockedTarget?: RoutingModelRef | null;
  pendingTarget?: RoutingModelRef | null;
  pendingAllowsPublic?: boolean;
}): AttachmentRoutingStatus {
  if (lockedTarget) {
    return {
      kind: "locked",
      target: lockedTarget,
      title: "私有化部署模型已启用",
      description: `本会话已锁定到「${lockedTarget.label}」。文档与后续消息都在企业私有环境中处理，不会发送到公网模型。`,
    };
  }
  if (!pendingTarget) return null;
  if (pendingAllowsPublic) {
    return {
      kind: "pending-choice",
      target: pendingTarget,
      title: "文档路由待确认",
      description: `发送时请选择「${pendingTarget.label}」私有模型，或明确继续使用当前公网模型；公网例外会写入企业审计。`,
    };
  }
  return {
    kind: "pending-private",
    target: pendingTarget,
    title: "已切换到私有化部署模型",
    description: `当前文档将由「${pendingTarget.label}」处理；发送后，本会话后续消息也会继续留在企业私有环境。`,
  };
}

export function AttachmentRoutingStatusBanner({
  lockedTarget,
  pendingTarget,
  pendingAllowsPublic = false,
  scopeKey = "global",
}: {
  lockedTarget?: RoutingModelRef | null;
  pendingTarget?: RoutingModelRef | null;
  pendingAllowsPublic?: boolean;
  scopeKey?: string;
}) {
  const status = resolveAttachmentRoutingStatus({
    lockedTarget,
    pendingTarget,
    pendingAllowsPublic,
  });
  const [dismissedStatusKeys, setDismissedStatusKeys] = useState<Set<string>>(() => new Set());
  if (!status) return null;

  const statusKey = attachmentRoutingStatusIdentity(scopeKey, status);
  if (dismissedStatusKeys.has(statusKey)) return null;

  const isChoice = status.kind === "pending-choice";
  const Icon = isChoice ? ShieldAlert : LockKeyhole;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="attachment-routing-status"
      data-routing-state={status.kind}
      className={`relative mb-2 flex min-w-0 items-start gap-3 rounded-xl border px-3.5 py-3 pr-11 shadow-sm ${
        isChoice
          ? "border-amber-500/35 bg-amber-500/10"
          : "border-cyan-500/35 bg-cyan-500/10"
      }`}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          isChoice ? "bg-amber-500/15 text-amber-300" : "bg-cyan-500/15 text-cyan-300"
        }`}
        aria-hidden
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-text-primary">{status.title}</span>
          <span
            className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              isChoice
                ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
                : "border-cyan-500/25 bg-cyan-500/10 text-cyan-200"
            }`}
            title={status.target.label}
          >
            {isChoice ? "待确认" : "私有部署"} · {status.target.label}
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-text-subtle">{status.description}</p>
      </div>
      <button
        type="button"
        aria-label="关闭路由提示"
        title="关闭本会话的路由提示"
        className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-hover hover:text-text-primary"
        onClick={() =>
          setDismissedStatusKeys((current) => {
            const next = new Set(current);
            next.add(statusKey);
            return next;
          })
        }
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
