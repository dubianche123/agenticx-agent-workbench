import { describe, expect, it } from "vitest";
import {
  buildConfirmRiskAssessment,
  confirmRiskCategoryCodes,
} from "./confirm-risk";

describe("confirmation risk taxonomy", () => {
  it("groups structured findings, keeps their evidence, and selects the strongest severity", () => {
    const context = {
      risk: "high",
      risk_categories: [
        { code: "shell_composition", evidence: "命令使用管道" },
        { code: "external_publish", evidence: "git push 会发布到远端" },
        { code: "external_publish", evidence: "git push --force 会覆盖远端历史" },
      ],
    };

    const assessment = buildConfirmRiskAssessment(context);
    expect(assessment.severity).toBe("critical");
    expect(assessment.levelLabel).toBe("严重风险");
    expect(assessment.categories).toEqual([
      expect.objectContaining({
        code: "shell_composition",
        label: "Shell 组合执行",
        evidence: ["命令使用管道"],
      }),
      expect.objectContaining({
        code: "external_publish",
        label: "影响远端或外部系统",
        evidence: ["git push 会发布到远端", "git push --force 会覆盖远端历史"],
      }),
    ]);
    expect(confirmRiskCategoryCodes(context)).toEqual([
      "external_publish",
      "shell_composition",
    ]);
  });

  it("maps legacy protected risks into explicit product categories", () => {
    expect(buildConfirmRiskAssessment({ risk: "permission_escalation" })).toMatchObject({
      severity: "critical",
      categories: [{ code: "host_full_access", label: "主机完全访问" }],
    });
    expect(buildConfirmRiskAssessment({ risk: "non_whitelisted" })).toMatchObject({
      severity: "guarded",
      categories: [{ code: "unrecognized_command", label: "未归类命令" }],
    });
    expect(
      buildConfirmRiskAssessment({ risk: "policy", tool: "memory_append" }),
    ).toMatchObject({
      categories: [{ code: "persistent_memory_change", label: "长期记忆变更" }],
    });
  });

  it("fails closed for missing and future risk values", () => {
    for (const context of [{}, { risk: "future-risk" }]) {
      expect(buildConfirmRiskAssessment(context)).toMatchObject({
        severity: "guarded",
        categories: [{ code: "unclassified_protected" }],
      });
    }
    expect(buildConfirmRiskAssessment({ risk: "low" })).toMatchObject({
      severity: "low",
      categories: [],
    });
  });
});
