"use client";

import { SupportAssistantLauncher, type SupportAssistantPlacement } from "@agenticx/ui";

export type PortalSupportAssistantProps = {
  path: string;
  tab?: string;
  placement?: SupportAssistantPlacement;
};

export function SupportAssistant({ path, tab, placement }: PortalSupportAssistantProps) {
  return (
    <SupportAssistantLauncher
      surface="portal"
      page={{ path, ...(tab ? { tab } : {}) }}
      label="智能助手"
      placement={placement}
    />
  );
}
