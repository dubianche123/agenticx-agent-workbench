import { beforeEach, describe, expect, it, vi } from "vitest";

import { shouldUseMockChatClient } from "./chat-client-mode";

describe("shouldUseMockChatClient", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not bypass the BFF when only the legacy mode flag is set", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_CLIENT_MODE", "mock");

    expect(shouldUseMockChatClient()).toBe(false);
  });

  it("requires an explicit mock opt-in", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CHAT_CLIENT_MODE", "mock");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MOCK_CHAT", "true");

    expect(shouldUseMockChatClient()).toBe(true);
  });

  it("never enables the mock client in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_CHAT_CLIENT_MODE", "mock");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MOCK_CHAT", "true");

    expect(shouldUseMockChatClient()).toBe(false);
  });

  it("does not enable mock when the client mode is not mock", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CHAT_CLIENT_MODE", "http");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MOCK_CHAT", "true");

    expect(shouldUseMockChatClient()).toBe(false);
  });
});
