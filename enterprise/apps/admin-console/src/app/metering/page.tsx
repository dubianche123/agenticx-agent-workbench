"use client";

import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@agenticx/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { useLocale } from "next-intl";

import { BillingSplitPanel } from "../../components/metering/BillingSplitPanel";
import { BudgetPanel } from "../../components/metering/BudgetPanel";
import { UsagePanel } from "../../components/metering/UsagePanel";

const TAB_IDS = ["usage", "split", "budget"] as const;

type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && TAB_IDS.some((tab) => tab === value);
}

/**
 * 用量与成本：花了多少、怎么分摊、上限是多少。
 *
 * 预算原本单独占一个菜单（/metering/quota）。预算和实际用量分两个页面看，等于每次都要
 * 记住另一页的数字再回来比——它们本来就是同一个问题的两面。
 */
function MeteringTabs() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const tabs = [
    { id: "usage", label: copy("用量", "Usage") },
    { id: "split", label: copy("分账", "Billing split") },
    { id: "budget", label: copy("预算", "Budget") },
  ] as const;
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const active: TabId = isTabId(raw) ? raw : "usage";

  const onChange = useCallback(
    (value: string) => {
      router.replace(value === "usage" ? "/metering" : `/metering?tab=${value}`);
    },
    [router],
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
      <TabsContent value="usage" className="pt-4">
        <UsagePanel />
      </TabsContent>
      <TabsContent value="split" className="pt-4">
        <BillingSplitPanel />
      </TabsContent>
      <TabsContent value="budget" className="pt-4">
        <BudgetPanel />
      </TabsContent>
    </Tabs>
  );
}

export default function MeteringPage() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={copy("用量与成本", "Usage & costs")}
        description={copy(
          "查看组织用量、成本分摊与预算执行情况。",
          "Review organization usage, cost allocation, and budget execution.",
        )}
      />
      <Suspense fallback={null}>
        <MeteringTabs />
      </Suspense>
    </div>
  );
}
