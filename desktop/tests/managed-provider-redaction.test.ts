import { describe, expect, it } from "vitest";

import { redactManagedProviderSecrets } from "../electron/managed-provider-redaction";

describe("managed provider renderer redaction", () => {
  it("removes managed PATs without mutating saved provider config", () => {
    const providers = {
      enterprise: {
        managed: true,
        api_key: "agx-pat-secret",
        base_url: "https://portal.example.invalid/api/desktop/v1",
      },
      openai: {
        managed: false,
        api_key: "personal-key",
        base_url: "https://api.openai.com/v1",
      },
    };

    const safe = redactManagedProviderSecrets(providers);

    expect(safe.enterprise).not.toHaveProperty("api_key");
    expect(safe.openai.api_key).toBe("personal-key");
    expect(providers.enterprise.api_key).toBe("agx-pat-secret");
  });

  it("also redacts a managed provider stored under another name", () => {
    const safe = redactManagedProviderSecrets({
      companyGateway: { managed: true, api_key: "secret" },
    });
    expect(safe.companyGateway).not.toHaveProperty("api_key");
  });
});
