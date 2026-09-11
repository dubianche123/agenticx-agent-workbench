"use client";

import * as React from "react";
import type { RoutingModelRef } from "@agenticx/config";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@agenticx/ui";
import { LockKeyhole, ShieldAlert, X } from "lucide-react";

export type PortalAttachmentRoutingStatus =
  | {
      kind: "locked" | "pending-private" | "pending-choice" | "public-exception";
      target: RoutingModelRef;
      title: string;
      description: string;
    }
  | null;

export function portalAttachmentRoutingStatusIdentity(
  scopeKey: string,
  status: Exclude<PortalAttachmentRoutingStatus, null>,
): string {
  return `${scopeKey}:${status.kind}:${status.target.id}`;
}

export function resolvePortalAttachmentRoutingStatus({
  target,
  composerHasRoutedDocument,
  sessionHasRoutedDocument,
  privateSessionLocked,
  canChoosePublicRoute,
}: {
  target?: RoutingModelRef | null;
  composerHasRoutedDocument: boolean;
  sessionHasRoutedDocument: boolean;
  privateSessionLocked: boolean;
  canChoosePublicRoute: boolean;
}): PortalAttachmentRoutingStatus {
  if (!target) return null;
  if (privateSessionLocked) {
    return {
      kind: "locked",
      target,
      title: "私有化部署模型已启用",
      description: `本会话已锁定到「${target.label}」。文档与后续消息都在企业私有环境中处理，不会发送到公网模型。`,
    };
  }
  if (composerHasRoutedDocument && canChoosePublicRoute) {
    return {
      kind: "pending-choice",
      target,
      title: "文档路由待确认",
      description: `发送时请选择「${target.label}」私有模型，或明确继续使用当前公网模型；公网例外会写入企业审计。`,
    };
  }
  if (composerHasRoutedDocument || sessionHasRoutedDocument) {
    if (canChoosePublicRoute) {
      return {
        kind: "public-exception",
        target,
        title: "当前会话正在使用公网模型例外",
        description: `本会话包含受治理文档，当前模型位于企业私有环境之外；后续发送仍会留下审计记录，可切换到「${target.label}」。`,
      };
    }
    return {
      kind: "pending-private",
      target,
      title: "已切换到私有化部署模型",
      description: `当前文档将由「${target.label}」处理；发送后，本会话后续消息也会继续留在企业私有环境。`,
    };
  }
  return null;
}

export function AttachmentRoutingStatusAlert({
  target,
  composerHasRoutedDocument,
  sessionHasRoutedDocument,
  privateSessionLocked,
  canChoosePublicRoute,
  scopeKey,
}: {
  target?: RoutingModelRef | null;
  composerHasRoutedDocument: boolean;
  sessionHasRoutedDocument: boolean;
  privateSessionLocked: boolean;
  canChoosePublicRoute: boolean;
  scopeKey: string;
}) {
  const status = resolvePortalAttachmentRoutingStatus({
    target,
    composerHasRoutedDocument,
    sessionHasRoutedDocument,
    privateSessionLocked,
    canChoosePublicRoute,
  });
  const [dismissedStatusKeys, setDismissedStatusKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  if (!status) return null;

  const statusKey = portalAttachmentRoutingStatusIdentity(scopeKey, status);
  if (dismissedStatusKeys.has(statusKey)) return null;

  const isWarning = status.kind === "pending-choice" || status.kind === "public-exception";
  const Icon = isWarning ? ShieldAlert : LockKeyhole;
  const badgeLabel =
    status.kind === "locked" || status.kind === "pending-private"
      ? "私有部署"
      : status.kind === "pending-choice"
        ? "待确认"
        : "公网例外";
  const badgeText = `${badgeLabel} · ${status.target.label}`;

  return (
    <Alert
      role="status"
      aria-live="polite"
      data-testid="attachment-routing-status"
      data-routing-state={status.kind}
      variant={isWarning ? "warning" : "default"}
      className={
        isWarning
          ? "relative border-amber-300/60 bg-amber-50/90 pr-12 text-amber-950 shadow-sm dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
          : "relative border-cyan-300/60 bg-cyan-50/90 pr-12 text-cyan-950 shadow-sm dark:border-cyan-500/35 dark:bg-cyan-500/10 dark:text-cyan-100"
      }
    >
      <Icon className="h-5 w-5" />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AlertTitle>{status.title}</AlertTitle>
          <span
            className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              isWarning
                ? "border-amber-300/60 bg-amber-100/80 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
                : "border-cyan-300/60 bg-cyan-100/80 text-cyan-900 dark:border-cyan-500/25 dark:bg-cyan-500/10 dark:text-cyan-100"
            }`}
            title={status.target.label}
          >
            {badgeText}
          </span>
        </div>
        <AlertDescription>{status.description}</AlertDescription>
      </div>
      <button
        type="button"
        aria-label="关闭路由提示"
        title="关闭本会话的路由提示"
        className="absolute right-2.5 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded-lg opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
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
    </Alert>
  );
}
