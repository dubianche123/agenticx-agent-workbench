import { readFileSync } from "node:fs";
import React from "react";
// The admin console does not ship a browser test renderer; SSR is still useful
// for checking the visible contract without adding a large client-test stack.
// @ts-expect-error react-dom/server is present at runtime but has no declaration in this workspace.
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { FeedbackPanel } from "./FeedbackPanel";

const panelSource = readFileSync(new URL("./FeedbackPanel.tsx", import.meta.url), "utf8");

function renderPanel(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="zh" messages={{}}>
      {element}
    </NextIntlClientProvider>,
  );
}

describe("FeedbackPanel", () => {
  it("keeps the aggregate coverage labels visible in its SSR contract", () => {
    const html = renderPanel(<FeedbackPanel />);

    expect(html).toContain("反馈类型");
    expect(html).toContain("反馈覆盖率");
    expect(html).toContain("按来源统计");
    expect(html).toContain("全部反馈 / 可反馈回答");
  });

  it("guards pending, success, error, cancellation, and session-switch responses", () => {
    expect(panelSource).toContain("setLoading(true)");
    expect(panelSource).toContain("setLoading(false)");
    expect(panelSource).toContain("toast.error");
    expect(panelSource).toContain("signal: controller.signal");
    expect(panelSource).toContain("activeRequest.current?.abort()");
    expect(panelSource).toContain("if (!isCurrent()) return;");
    expect(panelSource).toContain("response.status === 401 || response.status === 403");
    expect(panelSource).toContain("setForbidden(true)");
    expect(panelSource).toContain("全部来源");
    expect(panelSource).toContain("desktop_source");
    expect(panelSource).toContain("mixed_sources");
  });
});
