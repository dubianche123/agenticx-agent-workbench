export type AuditEventLabel = { zh: string; en: string };

export const AUDIT_EVENT_LABELS: Readonly<Record<string, AuditEventLabel>> = {
  chat_call: { zh: "模型调用", en: "Model call" },
  mcp_tool_call: { zh: "MCP 工具调用", en: "MCP tool call" },
  "attachment_routing.public_override": { zh: "附件公网例外", en: "Attachment public override" },
  "attachment_routing.private_route": {
    zh: "附件私有强制路由",
    en: "Attachment private route enforced",
  },
  "attachment_routing.public_override_denied": {
    zh: "附件公网例外拒绝",
    en: "Attachment public override denied",
  },
  "attachment_routing.private_route_denied": {
    zh: "附件私有路由拒绝",
    en: "Attachment private route denied",
  },
  "attachment_routing.invalid_marker": {
    zh: "附件路由标记无效",
    en: "Attachment routing marker invalid",
  },
  "attachment_routing.update": {
    zh: "附件公网例外配置变更",
    en: "Attachment public override configuration update",
  },
};

/**
 * The audit table must not infer safety from an empty `policies_hit` array:
 * routing decisions are recorded as dedicated events and normally have no
 * content-policy hit attached to them. Keep this classifier pure so the
 * list and detail views cannot drift into different status semantics.
 */
export type AuditEventStatus =
  | "compliant"
  | "policy_hit"
  | "public_override"
  | "private_route"
  | "rejected";

export function getAuditEventStatus(
  eventType: string,
  policyHitCount = 0,
): AuditEventStatus {
  switch (eventType) {
    case "attachment_routing.public_override":
      return "public_override";
    case "attachment_routing.private_route":
      return "private_route";
    case "attachment_routing.public_override_denied":
    case "attachment_routing.private_route_denied":
    case "attachment_routing.invalid_marker":
      return "rejected";
    default:
      return policyHitCount > 0 ? "policy_hit" : "compliant";
  }
}

const AUDIT_STATUS_LABELS: Readonly<Record<AuditEventStatus, AuditEventLabel>> = {
  compliant: { zh: "合规", en: "Compliant" },
  policy_hit: { zh: "策略命中", en: "Policy hit" },
  public_override: { zh: "已授权例外", en: "Authorized exception" },
  private_route: { zh: "私有强制路由", en: "Private route enforced" },
  rejected: { zh: "已拒绝", en: "Denied" },
};

export function formatAuditEventStatusLabel(
  status: AuditEventStatus,
  locale: string,
): string {
  const label = AUDIT_STATUS_LABELS[status];
  return label[locale === "zh" ? "zh" : "en"];
}

export function formatAuditEventLabel(value: string, locale: string): string {
  const label = AUDIT_EVENT_LABELS[value];
  return label ? label[locale === "zh" ? "zh" : "en"] : value;
}
