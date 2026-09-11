import { describe, expect, it } from "vitest";
import { getLoginFailureStatusMessage } from "../../lib/admin-login-failure-message";

describe("admin login failure copy", () => {
  const generic = "邮箱或密码错误，或账号暂时不可用。";

  it.each([
    ["unknown account", undefined],
    ["existing account with a wrong password", "invalid credentials"],
    ["existing account after repeated failures", "account temporarily locked"],
  ])("uses the same localized generic copy for %s", (_caseName, responseMessage) => {
    expect(getLoginFailureStatusMessage(responseMessage, generic)).toBe(generic);
  });
});
