import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AttachmentRoutingStatusAlert,
  portalAttachmentRoutingStatusIdentity,
  resolvePortalAttachmentRoutingStatus,
} from "./AttachmentRoutingStatusAlert";

const PRIVATE_GLM = {
  id: "hc0818-glm-private/glm-5.2",
  provider: "hc0818-glm-private",
  model: "glm-5.2",
  label: "GLM 5.2 私有路由验收",
};

const BASE = {
  target: PRIVATE_GLM,
  composerHasRoutedDocument: false,
  sessionHasRoutedDocument: false,
  privateSessionLocked: false,
  canChoosePublicRoute: false,
};

describe("AttachmentRoutingStatusAlert", () => {
  it("does not render for an ordinary conversation", () => {
    expect(resolvePortalAttachmentRoutingStatus(BASE)).toBeNull();
  });

  it("keeps a private session status visible after the composer is cleared", () => {
    const html = renderToStaticMarkup(
      <AttachmentRoutingStatusAlert
        {...BASE}
        sessionHasRoutedDocument
        privateSessionLocked
        scopeKey="session-a"
      />,
    );

    expect(html).toContain('data-routing-state="locked"');
    expect(html).toContain("私有化部署模型已启用");
    expect(html).toContain("不会发送到公网模型");
    expect(html).toContain('aria-label="关闭路由提示"');
  });

  it("uses the same prominent pending state before a forced private send", () => {
    const html = renderToStaticMarkup(
      <AttachmentRoutingStatusAlert
        {...BASE}
        composerHasRoutedDocument
        scopeKey="session-a"
      />,
    );

    expect(html).toContain('data-routing-state="pending-private"');
    expect(html).toContain("已切换到私有化部署模型");
    expect(html).toContain("私有部署 · GLM 5.2 私有路由验收");
  });

  it("does not mislabel an explicit public-route exception as private", () => {
    const status = resolvePortalAttachmentRoutingStatus({
      ...BASE,
      sessionHasRoutedDocument: true,
      canChoosePublicRoute: true,
    });

    expect(status?.kind).toBe("public-exception");
    expect(status?.title).toContain("公网模型例外");
  });

  it("keeps close state isolated between browser sessions", () => {
    const status = resolvePortalAttachmentRoutingStatus({
      ...BASE,
      sessionHasRoutedDocument: true,
      privateSessionLocked: true,
    });
    expect(status).not.toBeNull();
    if (!status) return;

    expect(portalAttachmentRoutingStatusIdentity("session-a", status)).not.toBe(
      portalAttachmentRoutingStatusIdentity("session-b", status),
    );
  });
});
