import { describe, expect, it } from "vitest";

import { gatewayHref, resolveGatewaySection } from "../gateway-navigation";

describe("gateway navigation", () => {
  it("keeps model access as the canonical workspace route", () => {
    expect(gatewayHref("models")).toBe("/admin/gateway");
  });

  it("addresses traffic, cache, and short-lived grants inside the workspace", () => {
    expect(gatewayHref("traffic")).toBe("/admin/gateway?section=traffic");
    expect(gatewayHref("cache")).toBe("/admin/gateway?section=cache");
    expect(gatewayHref("credentials", "grants")).toBe(
      "/admin/gateway?section=credentials&credential=grants",
    );
  });

  it("falls back to model access for unknown sections", () => {
    expect(resolveGatewaySection("missing")).toBe("models");
    expect(resolveGatewaySection(null)).toBe("models");
  });
});
