import { describe, expect, it } from "vitest";

import { normalizePricingConfig as normalizeMysql } from "../mysql/pricing-store";
import { normalizePricingConfig as normalizePostgresql } from "../postgresql/pricing-store";

const INPUT = {
  version: "test",
  default: { input: 0.000001, output: 0.000002 },
  models: {
    "private/qwen": [
      {
        input: 0.000001,
        output: 0.000002,
        billingMultiplier: 0,
      },
    ],
  },
};

describe.each([
  ["PostgreSQL", normalizePostgresql],
  ["MySQL", normalizeMysql],
])("%s pricing config", (_dialect, normalize) => {
  it("preserves an explicit zero billing multiplier", () => {
    const config = normalize(INPUT);
    expect(config.models["private/qwen"]?.[0]?.billingMultiplier).toBe(0);
  });

  it("clamps a negative multiplier instead of allowing negative cost", () => {
    const config = normalize({
      ...INPUT,
      models: {
        "private/qwen": [{ ...INPUT.models["private/qwen"][0]!, billingMultiplier: -2 }],
      },
    });
    expect(config.models["private/qwen"]?.[0]?.billingMultiplier).toBe(0);
  });
});
