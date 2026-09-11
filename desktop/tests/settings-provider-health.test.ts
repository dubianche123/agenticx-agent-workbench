import { describe, expect, it } from "vitest";

import { shouldApplyProviderHealthCheck } from "../src/components/SettingsPanel";

describe("provider health-check response fencing", () => {
  it("drops a deferred response after switching providers", async () => {
    let activeProvider = "provider-a";
    let generation = 1;
    let appliedProvider: string | null = null;
    let release: (() => void) | undefined;

    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestedProvider = activeProvider;
    const requestedGeneration = generation;
    const pending = response.then(() => {
      if (!shouldApplyProviderHealthCheck(
        requestedProvider,
        activeProvider,
        requestedGeneration,
        generation,
      )) return;
      appliedProvider = requestedProvider;
    });

    activeProvider = "provider-b";
    generation = 2;
    release?.();
    await pending;

    expect(appliedProvider).toBeNull();
    expect(shouldApplyProviderHealthCheck("provider-b", activeProvider, 2, generation)).toBe(true);
  });
});
