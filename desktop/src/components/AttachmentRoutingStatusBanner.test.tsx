import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AttachmentRoutingStatusBanner,
  attachmentRoutingStatusIdentity,
  resolveAttachmentRoutingStatus,
} from "./AttachmentRoutingStatusBanner";

const PRIVATE_GLM = {
  id: "hc0818-glm-private/glm-5.2",
  provider: "hc0818-glm-private",
  model: "glm-5.2",
  label: "GLM 5.2 私有路由验收",
};

describe("AttachmentRoutingStatusBanner", () => {
  it("stays absent for an ordinary unlocked conversation", () => {
    expect(resolveAttachmentRoutingStatus({})).toBeNull();
    expect(renderToStaticMarkup(<AttachmentRoutingStatusBanner />)).toBe("");
  });

  it("announces the immediate private switch while a governed document is pending", () => {
    const html = renderToStaticMarkup(
      <AttachmentRoutingStatusBanner pendingTarget={PRIVATE_GLM} />,
    );

    expect(html).toContain('data-routing-state="pending-private"');
    expect(html).toContain("已切换到私有化部署模型");
    expect(html).toContain("私有部署 · GLM 5.2 私有路由验收");
    expect(html).toContain("发送后，本会话后续消息也会继续留在企业私有环境");
  });

  it("shows an explicit choice instead of claiming a private lock for public-route exceptions", () => {
    const html = renderToStaticMarkup(
      <AttachmentRoutingStatusBanner
        pendingTarget={PRIVATE_GLM}
        pendingAllowsPublic
      />,
    );

    expect(html).toContain('data-routing-state="pending-choice"');
    expect(html).toContain("文档路由待确认");
    expect(html).toContain("待确认 · GLM 5.2 私有路由验收");
    expect(html).not.toContain("私有化部署模型已启用");
  });

  it("keeps the authoritative session lock visible after the attachment leaves the composer", () => {
    const status = resolveAttachmentRoutingStatus({ lockedTarget: PRIVATE_GLM });
    const html = renderToStaticMarkup(
      <AttachmentRoutingStatusBanner lockedTarget={PRIVATE_GLM} />,
    );

    expect(status?.kind).toBe("locked");
    expect(html).toContain('data-routing-state="locked"');
    expect(html).toContain("私有化部署模型已启用");
    expect(html).toContain("文档与后续消息都在企业私有环境中处理");
    expect(html).toContain("不会发送到公网模型");
    expect(html).toContain('aria-label="关闭路由提示"');
  });

  it("lets a persisted lock win over a newly pending public-choice document", () => {
    const status = resolveAttachmentRoutingStatus({
      lockedTarget: PRIVATE_GLM,
      pendingTarget: { ...PRIVATE_GLM, label: "另一个目标" },
      pendingAllowsPublic: true,
    });

    expect(status).toMatchObject({
      kind: "locked",
      target: PRIVATE_GLM,
      title: "私有化部署模型已启用",
    });
  });

  it("scopes a dismissed banner to one conversation", () => {
    const status = resolveAttachmentRoutingStatus({ lockedTarget: PRIVATE_GLM });
    expect(status).not.toBeNull();
    if (!status) return;

    expect(attachmentRoutingStatusIdentity("session-a", status)).not.toBe(
      attachmentRoutingStatusIdentity("session-b", status),
    );
  });
});
