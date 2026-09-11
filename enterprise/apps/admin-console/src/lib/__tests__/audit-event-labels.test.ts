import { describe, expect, it } from "vitest";

import {
  formatAuditEventLabel,
  formatAuditEventStatusLabel,
  getAuditEventStatus,
} from "../audit-event-labels";

describe("audit event labels", () => {
  it("localizes attachment routing configuration updates", () => {
    expect(formatAuditEventLabel("attachment_routing.update", "zh")).toBe("附件公网例外配置变更");
    expect(formatAuditEventLabel("attachment_routing.update", "en")).toBe(
      "Attachment public override configuration update",
    );
  });

  it("keeps existing public override labels and unknown-event fallback", () => {
    expect(formatAuditEventLabel("attachment_routing.public_override", "zh")).toBe("附件公网例外");
    expect(formatAuditEventLabel("unknown.event", "en")).toBe("unknown.event");
  });

  it("localizes private and denied attachment routing events", () => {
    expect(formatAuditEventLabel("attachment_routing.private_route", "zh")).toBe("附件私有强制路由");
    expect(formatAuditEventLabel("attachment_routing.public_override_denied", "en")).toBe(
      "Attachment public override denied",
    );
    expect(formatAuditEventLabel("attachment_routing.private_route_denied", "zh")).toBe(
      "附件私有路由拒绝",
    );
    expect(formatAuditEventLabel("attachment_routing.invalid_marker", "zh")).toBe(
      "附件路由标记无效",
    );
    expect(formatAuditEventLabel("attachment_routing.invalid_marker", "en")).toBe(
      "Attachment routing marker invalid",
    );
  });

  it("classifies routing outcomes independently of policy-hit data", () => {
    expect(getAuditEventStatus("attachment_routing.private_route", 0)).toBe("private_route");
    expect(getAuditEventStatus("attachment_routing.public_override", 0)).toBe("public_override");
    expect(getAuditEventStatus("attachment_routing.public_override_denied", 0)).toBe("rejected");
    expect(getAuditEventStatus("attachment_routing.private_route_denied", 0)).toBe("rejected");
    expect(getAuditEventStatus("attachment_routing.invalid_marker", 0)).toBe("rejected");
    expect(getAuditEventStatus("chat_call", 0)).toBe("compliant");
    expect(getAuditEventStatus("chat_call", 1)).toBe("policy_hit");
    expect(formatAuditEventStatusLabel("private_route", "en")).toBe("Private route enforced");
    expect(formatAuditEventStatusLabel("rejected", "zh")).toBe("已拒绝");
  });
});
