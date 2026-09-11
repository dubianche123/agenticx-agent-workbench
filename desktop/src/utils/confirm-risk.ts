export type ConfirmRiskSeverity = "low" | "guarded" | "high" | "critical";

export type ConfirmRiskCategory = {
  code: string;
  label: string;
  description: string;
  severity: Exclude<ConfirmRiskSeverity, "low">;
  evidence: string[];
};

export type ConfirmRiskAssessment = {
  severity: ConfirmRiskSeverity;
  levelLabel: string;
  headline: string;
  categories: ConfirmRiskCategory[];
};

type RiskDefinition = Omit<ConfirmRiskCategory, "code" | "evidence">;

/** Product-facing taxonomy for every protected operation emitted by the backend. */
export const CONFIRM_RISK_CATALOG: Readonly<Record<string, RiskDefinition>> = {
  host_full_access: {
    label: "主机完全访问",
    description:
      "这一次不套任何文件沙箱：命令可改动工作区之外的主机文件，你设置的路径拒绝规则也不生效。仅本次有效，无法保存为长期批准。",
    severity: "critical",
  },
  destructive_filesystem: {
    label: "删除或覆盖数据",
    description: "可能删除文件、清理未提交内容，或不可逆地覆盖已有状态。",
    severity: "critical",
  },
  system_disruption: {
    label: "系统或设备操作",
    description: "可能操作磁盘、文件系统、电源或系统级服务。",
    severity: "critical",
  },
  external_publish: {
    label: "影响远端或外部系统",
    description: "会向远端推送、发布或覆盖外部系统中的状态。",
    severity: "critical",
  },
  arbitrary_code_execution: {
    label: "执行脚本或动态代码",
    description: "脚本、模块或内联代码可以继续执行当前命令之外的逻辑。",
    severity: "high",
  },
  dependency_change: {
    label: "依赖与环境变更",
    description: "会安装、删除或升级项目依赖、运行时或系统软件包。",
    severity: "high",
  },
  shell_composition: {
    label: "Shell 组合执行",
    description: "包含管道、重定向、命令串联、子命令或多行 Shell 语法。",
    severity: "high",
  },
  version_control_change: {
    label: "版本库状态变更",
    description: "会修改提交、索引、分支或工作树，而不只是读取仓库状态。",
    severity: "high",
  },
  third_party_extension: {
    label: "第三方扩展代码",
    description: "将安装或启用可参与后续智能体运行的第三方技能。",
    severity: "high",
  },
  agent_extension_change: {
    label: "智能体扩展变更",
    description: "会创建、修改或删除可参与后续智能体运行的技能代码。",
    severity: "high",
  },
  unrecognized_command: {
    label: "未归类命令",
    description: "命令不在已知的低风险命令集合中，需要由你判断用途。",
    severity: "guarded",
  },
  persistent_memory_change: {
    label: "长期记忆变更",
    description: "内容会写入长期或全局记忆，影响之后的对话和智能体行为。",
    severity: "guarded",
  },
  protected_policy_change: {
    label: "受保护配置变更",
    description: "会改变技能、策略或其他可持续影响后续运行的配置。",
    severity: "guarded",
  },
  unclassified_protected: {
    label: "尚未归类的受保护操作",
    description: "系统没有足够信息证明它是低风险操作，因此按受保护操作处理。",
    severity: "guarded",
  },
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackRiskCode(context?: Record<string, unknown>): string {
  const risk = text(context?.risk).toLowerCase();
  if (risk === "permission_escalation") return "host_full_access";
  if (risk === "destructive") return "destructive_filesystem";
  if (risk === "non_whitelisted") return "unrecognized_command";
  if (risk === "policy") {
    const tool = text(context?.tool);
    if (tool === "memory_append") return "persistent_memory_change";
    if (tool === "skill_market_install") {
      return "third_party_extension";
    }
    if (tool === "skill_manage") return "agent_extension_change";
    return "protected_policy_change";
  }
  return "unclassified_protected";
}

export function confirmRiskCategoryCodes(context?: Record<string, unknown>): string[] {
  const entries = Array.isArray(context?.risk_categories) ? context.risk_categories : [];
  const codes = entries
    .map((entry) =>
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object"
          ? text((entry as Record<string, unknown>).code)
          : "",
    )
    .filter(Boolean);
  if (codes.length === 0 && text(context?.risk).toLowerCase() !== "low") {
    codes.push(fallbackRiskCode(context));
  }
  return Array.from(new Set(codes)).sort();
}

export function buildConfirmRiskAssessment(
  context?: Record<string, unknown>,
): ConfirmRiskAssessment {
  const risk = text(context?.risk).toLowerCase();
  if (risk === "low") {
    return {
      severity: "low",
      levelLabel: "低风险",
      headline: "操作受工作区边界保护",
      categories: [],
    };
  }

  const rawEntries = Array.isArray(context?.risk_categories) ? context.risk_categories : [];
  const evidenceByCode = new Map<string, string[]>();
  for (const entry of rawEntries) {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    const code = typeof entry === "string" ? entry.trim() : text(row?.code);
    if (!code) continue;
    const evidence = text(row?.evidence);
    const values = evidenceByCode.get(code) ?? [];
    if (evidence && !values.includes(evidence)) values.push(evidence);
    evidenceByCode.set(code, values);
  }
  if (evidenceByCode.size === 0) {
    evidenceByCode.set(fallbackRiskCode(context), []);
  }

  const categories = Array.from(evidenceByCode.entries()).map(([code, evidence]) => {
    const definition = CONFIRM_RISK_CATALOG[code] ?? CONFIRM_RISK_CATALOG.unclassified_protected;
    return { code, ...definition, evidence };
  });
  const severityOrder: Record<ConfirmRiskSeverity, number> = {
    low: 0,
    guarded: 1,
    high: 2,
    critical: 3,
  };
  const severity = categories.reduce<Exclude<ConfirmRiskSeverity, "low">>(
    (current, item) => severityOrder[item.severity] > severityOrder[current] ? item.severity : current,
    "guarded",
  );
  return {
    severity,
    levelLabel:
      severity === "critical" ? "严重风险" : severity === "high" ? "高风险" : "受保护操作",
    headline:
      severity === "critical"
        ? "此操作可能产生不可逆或工作区外影响"
        : severity === "high"
          ? "此操作包含需要你判断的高风险能力"
          : "此操作不会被自动批准",
    categories,
  };
}
