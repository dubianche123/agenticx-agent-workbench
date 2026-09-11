"use client";

import { SpendingLimitEditor } from "./metering/SpendingLimitEditor";
import { useLocale } from "next-intl";

export function DefaultMemberBudgetCard() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return (
    <SpendingLimitEditor
      scope="defaults"
      variant="card"
      title={copy("普通成员默认上限", "Default member limit")}
      description={copy("未单独设置的成员都使用这条规则。Token 与美元严格二选一；部门、用户组批量操作或个人设置可以覆盖它。", "Members without a personal rule use this limit. Choose Token or USD; departments, groups, or personal settings can override it.")}
      enableLabel={copy("启用普通成员默认上限", "Enable default member limit")}
      inheritDescription={copy("关闭后普通成员默认不设金额上限，只有被部门或个人规则覆盖的人受限。", "When off, members have no default amount limit; only members covered by department or personal rules are limited.")}
      limitLabel={copy("每人上限", "Per-member limit")}
    />
  );
}
