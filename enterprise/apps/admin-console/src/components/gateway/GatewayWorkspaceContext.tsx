"use client";

import { createContext, useContext, type ReactNode } from "react";

const GatewayWorkspaceContext = createContext(false);

export function GatewayWorkspaceProvider({ children }: { children: ReactNode }) {
  return (
    <GatewayWorkspaceContext.Provider value>
      {children}
    </GatewayWorkspaceContext.Provider>
  );
}

export function useGatewayWorkspace(): boolean {
  return useContext(GatewayWorkspaceContext);
}

export function GatewayPanelHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
