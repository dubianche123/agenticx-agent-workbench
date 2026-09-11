"use client";

import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@agenticx/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { useLocale } from "next-intl";

import { AgentTracesPanel } from "../../../components/governance/AgentTracesPanel";
import { AuditPanel } from "../../../components/governance/AuditPanel";
import { CompliancePanel } from "../../../components/governance/CompliancePanel";
import { FeedbackPanel } from "../../../components/governance/FeedbackPanel";
import { PolicyPanel } from "../../../components/governance/PolicyPanel";
import { PortalLogsPanel } from "../../../components/governance/PortalLogsPanel";

const TAB_IDS = ["audit", "logs", "traces", "feedback", "policy", "compliance"] as const;

type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && TAB_IDS.some((tab) => tab === value);
}

/**
 * 安全与审计：发生过什么、按什么规则拦、留多久。
 *
 * 原本是五个一级菜单——操作审计、Portal 日志、Token 追踪、内容策略、合规留存。查一件事
 * 通常要串着看：审计里看到一次调用，要去日志里看请求，再去追踪里看这轮花了多少 token。
 * 拆成五个入口的结果是管理员自己在标签页之间来回跳，还得记住哪个页面查得到什么。
 */
function GovernanceTabs() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const tabs = [
    { id: "audit", label: copy("操作审计", "Audit") },
    { id: "logs", label: copy("请求日志", "Request logs") },
    { id: "traces", label: copy("Token 追踪", "Token traces") },
    { id: "feedback", label: copy("回答反馈", "Answer feedback") },
    { id: "policy", label: copy("内容策略", "Content policy") },
    { id: "compliance", label: copy("合规留存", "Compliance retention") },
  ] as const;
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const active: TabId = isTabId(raw) ? raw : "audit";

  const onChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value === "audit") next.delete("tab");
      else next.set("tab", value);
      const query = next.toString();
      router.replace(query ? `/admin/governance?${query}` : "/admin/governance");
    },
    [params, router],
  );

  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="audit" className="pt-4">
        <AuditPanel />
      </TabsContent>
      <TabsContent value="logs" className="pt-4">
        <PortalLogsPanel />
      </TabsContent>
      <TabsContent value="traces" className="pt-4">
        <AgentTracesPanel />
      </TabsContent>
      <TabsContent value="feedback" className="pt-4">
        <FeedbackPanel />
      </TabsContent>
      <TabsContent value="policy" className="pt-4">
        <PolicyPanel />
      </TabsContent>
      <TabsContent value="compliance" className="pt-4">
        <CompliancePanel />
      </TabsContent>
    </Tabs>
  );
}

export default function AdminGovernancePage() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={copy("安全与审计", "Security & audit")}
        description={copy(
          "集中查看操作记录、请求链路、内容策略与合规留存。",
          "Review operational records, request traces, content policy, and compliance retention.",
        )}
      />
      <Suspense fallback={null}>
        <GovernanceTabs />
      </Suspense>
    </div>
  );
}
