"use client";

import { SpendingLimitEditor, type SpendingLimitScope } from "./SpendingLimitEditor";
import { useLocale } from "next-intl";

export type BudgetScope = Exclude<SpendingLimitScope, "defaults">;

const COPY: Record<BudgetScope, { title: [string, string]; description: [string, string]; enable: [string, string]; inherit: [string, string]; limit: [string, string] }> = {
  tenants: {
    title: ["组织共享上限", "Organization limit"],
    description: ["整个组织共用这一条 Token 或美元上限；它不会和另一种单位同时生效。", "The organization shares one Token or USD limit; both units are never active at the same time."],
    enable: ["单独设置组织上限", "Set an organization limit"],
    inherit: ["关闭后不设置组织共享上限，成员仍按部门或个人规则执行。", "When off, members follow department or personal rules."],
    limit: ["组织共享上限", "Organization limit"],
  },
  departments: {
    title: ["部门共享上限", "Department limit"],
    description: ["部门成员共同消耗这一条 Token 或美元上限；个人规则优先于部门规则。", "Department members share one Token or USD limit; personal rules take precedence."],
    enable: ["单独设置部门上限", "Set a department limit"],
    inherit: ["关闭后该部门继承组织或普通成员默认规则。", "When off, the department inherits organization or member defaults."],
    limit: ["部门共享上限", "Department limit"],
  },
  users: {
    title: ["个人上限", "Personal limit"],
    description: ["只限制这个人。Token 与美元二选一，这条个人规则会覆盖部门和默认规则。", "Limits this member only. Choose Token or USD; this personal rule overrides department and default rules."],
    enable: ["单独设置个人上限", "Set a personal limit"],
    inherit: ["关闭后恢复继承部门或普通成员默认规则。", "When off, inherit department or member defaults again."],
    limit: ["每人上限", "Per-member limit"],
  },
};

export function BudgetScopeEditor({
  scope,
  id,
  onSaved,
}: {
  scope: BudgetScope;
  id?: string;
  onSaved?: () => void;
}) {
  const locale = useLocale();
  const source = COPY[scope];
  const pick = (value: [string, string]) => value[locale === "en" ? 1 : 0];
  return (
    <SpendingLimitEditor
      scope={scope}
      id={id}
      title={pick(source.title)}
      description={pick(source.description)}
      enableLabel={pick(source.enable)}
      inheritDescription={pick(source.inherit)}
      limitLabel={pick(source.limit)}
      onSaved={onSaved}
    />
  );
}
