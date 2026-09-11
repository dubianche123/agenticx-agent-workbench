import { describe, expect, it } from "vitest";
import {
  effectiveBillingMultiplier,
  pricePerMillion,
  providerModelPricingKey,
  resolveProviderModelPricing,
  syncPricingToProviderCatalog,
  updateProviderModelPrice,
  updateProviderModelBillingMultiplier,
  type PricingConfig,
} from "../model-pricing";

const BASE: PricingConfig = {
  version: "v1",
  default: { input: 0.000001, output: 0.000002 },
  models: {
    shared: [{ input: 0.000003, output: 0.000004 }],
    stale: [{ input: 99, output: 99 }],
  },
  updatedAt: "2026-08-15T00:00:00.000Z",
};

describe("provider model pricing", () => {
  it("uses provider/model identity while retaining legacy model fallback", () => {
    expect(providerModelPricingKey("moonshot", "shared")).toBe("moonshot/shared");
    expect(pricePerMillion(resolveProviderModelPricing(BASE, "moonshot", "shared"), "input")).toBe(3);

    const changed = updateProviderModelPrice(BASE, "moonshot", "shared", "input", 8.5);
    expect(pricePerMillion(resolveProviderModelPricing(changed, "moonshot", "shared"), "input")).toBe(8.5);
    expect(pricePerMillion(resolveProviderModelPricing(changed, "other", "shared"), "input")).toBe(3);
  });

  it("syncs prices to real provider models and removes stale manual catalog rows", () => {
    const synced = syncPricingToProviderCatalog(BASE, [
      { id: "moonshot", models: [{ name: "shared" }, { name: "kimi-new" }] },
      { id: "private", models: [{ name: "shared" }] },
    ]);
    expect(Object.keys(synced.models)).toEqual(["moonshot/shared", "moonshot/kimi-new", "private/shared"]);
    expect(synced.models.stale).toBeUndefined();
    expect(synced.models["moonshot/kimi-new"]?.[0]?.inputPerM).toBe(1);
  });

  it("preserves an explicit zero billing multiplier when prices change and catalogs sync", () => {
    const free = updateProviderModelBillingMultiplier(BASE, "private", "shared", 0);
    expect(effectiveBillingMultiplier(resolveProviderModelPricing(free, "private", "shared"))).toBe(0);

    const repriced = updateProviderModelPrice(free, "private", "shared", "output", 12);
    expect(effectiveBillingMultiplier(resolveProviderModelPricing(repriced, "private", "shared"))).toBe(0);

    const synced = syncPricingToProviderCatalog(repriced, [
      { id: "private", models: [{ name: "shared" }] },
    ]);
    expect(synced.models["private/shared"]?.[0]?.billingMultiplier).toBe(0);
  });

  it("uses one by default and clamps a negative multiplier to free instead of crediting cost", () => {
    expect(effectiveBillingMultiplier(BASE.default)).toBe(1);
    const changed = updateProviderModelBillingMultiplier(BASE, "private", "shared", -2);
    expect(effectiveBillingMultiplier(resolveProviderModelPricing(changed, "private", "shared"))).toBe(0);
  });
});
