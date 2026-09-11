"use client";

import * as React from "react";
import { CircleHelp, Loader2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import type { SupportAssistantPlacement, SupportPageContext, SupportSurface } from "./contracts";

const LazyPanel = React.lazy(() => import("./SupportAssistantPanel"));

export type SupportAssistantLauncherProps = {
  surface: SupportSurface;
  page: SupportPageContext;
  label?: string;
  className?: string;
  placement?: SupportAssistantPlacement;
};

/**
 * Small launcher with a lazy panel. The panel stays mounted after first open
 * so close/reopen keeps its independent context and in-flight UI state.
 */
export function SupportAssistantLauncher({
  surface,
  page,
  label = "打开环境助手",
  className,
  placement = "floating",
}: SupportAssistantLauncherProps) {
  const [open, setOpen] = React.useState(false);
  const [hasOpened, setHasOpened] = React.useState(false);

  const openPanel = React.useCallback(() => {
    setHasOpened(true);
    setOpen(true);
  }, []);

  return (
    <>
      {hasOpened ? (
        <React.Suspense
          fallback={(
            <div className={cn(
              "z-[60] flex h-20 w-[min(400px,calc(100vw-2rem))] items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground shadow-2xl",
              placement === "inline"
                ? "absolute right-0 top-10"
                : "fixed bottom-20 right-4",
            )}>
              <Loader2 className="h-5 w-5 animate-spin" aria-label="正在打开支持助手" />
            </div>
          )}
        >
          <LazyPanel
            open={open}
            onClose={() => setOpen(false)}
            surface={surface}
            page={page}
            placement={placement}
          />
        </React.Suspense>
      ) : null}
      <Button
        type="button"
        variant={placement === "inline" ? "ghost" : "default"}
        size={placement === "inline" ? "icon-sm" : "lg"}
        className={cn(
          placement === "inline"
            ? "h-8 w-8 rounded-full text-muted-foreground hover:bg-primary-soft hover:text-primary"
            : "fixed bottom-5 right-5 z-[60] rounded-full px-4 shadow-lg shadow-primary/20",
          className,
        )}
        onClick={openPanel}
        aria-label={label}
        title={label}
      >
        <CircleHelp className="h-4 w-4" />
        <span className={placement === "inline" ? "sr-only" : "hidden sm:inline"}>{label}</span>
      </Button>
    </>
  );
}
