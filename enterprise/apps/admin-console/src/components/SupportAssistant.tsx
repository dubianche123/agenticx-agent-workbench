"use client";

import { SupportAssistantLauncher } from "@agenticx/ui";

export type AdminSupportAssistantProps = {
  path: string;
  tab?: string;
};

export function SupportAssistant({ path, tab }: AdminSupportAssistantProps) {
  return (
    <SupportAssistantLauncher
      surface="admin"
      page={{ path, ...(tab ? { tab } : {}) }}
      label="智能助手"
    />
  );
}
