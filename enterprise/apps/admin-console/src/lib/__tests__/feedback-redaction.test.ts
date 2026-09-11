import { describe, expect, it } from "vitest";

import { redactFeedbackExcerpt } from "../feedback-redaction";

describe("redactFeedbackExcerpt", () => {
  it("removes reasoning, secrets and common PII from admin samples", () => {
    const result = redactFeedbackExcerpt(
      "<think>internal chain</think>联系 test@example.com 或 13800138000，api_key=abcdefghijklmnop，卡号 4111 1111 1111 1111。",
    );

    expect(result).not.toContain("internal chain");
    expect(result).not.toContain("test@example.com");
    expect(result).not.toContain("13800138000");
    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("4111 1111 1111 1111");
    expect(result).toContain("已脱敏");
  });

  it("redacts AWS access key ids and GitHub tokens", () => {
    const result = redactFeedbackExcerpt(
      "aws AKIAIOSFODNN7EXAMPLE github ghp_123456789012345678901234567890123456 and github_pat_1234567890abcdefghijklmnop",
    );

    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("ghp_123456789012345678901234567890123456");
    expect(result).not.toContain("github_pat_1234567890abcdefghijklmnop");
    expect(result.match(/已脱敏/g)?.length).toBe(3);
  });

  it("clips the preview without returning the full answer", () => {
    expect(redactFeedbackExcerpt("x".repeat(20), 8)).toBe("xxxxxxxx…");
  });
});
