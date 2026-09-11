import { describe, expect, it } from "vitest";

import { requestOriginFromRequest } from "./desktop-device-auth";

describe("requestOriginFromRequest", () => {
  it("prefers a configured public origin", () => {
    const request = new Request("http://portal-internal:3000/api/desktop/bootstrap", {
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
    });
    expect(
      requestOriginFromRequest(request, {
        WEB_PORTAL_PUBLIC_BASE_URL: "https://portal.example.com/base/path",
      }),
    ).toBe("https://portal.example.com");
  });

  it("ignores client-controlled forwarding headers", () => {
    const request = new Request("https://portal.example.com/api/desktop/bootstrap", {
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    });
    expect(requestOriginFromRequest(request, {})).toBe("https://portal.example.com");
  });
});
