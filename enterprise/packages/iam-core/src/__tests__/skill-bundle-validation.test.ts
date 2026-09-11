import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_SKILL_BUNDLE_BYTES,
  SkillBundleValidationError,
  isPrivateSkillBundleAddress,
  preflightSkillBundle,
  validateSkillBundleMetadata,
} from "../skill-bundle-validation";

const DIGEST = "a".repeat(64);
const lookupPublic = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

function errorCode(error: unknown): string | undefined {
  return error instanceof SkillBundleValidationError ? error.code : undefined;
}

describe("Skill bundle URI and digest validation", () => {
  it("requires a URI and digest pair and accepts only a 64-hex digest", () => {
    expect(validateSkillBundleMetadata({}, { nodeEnv: "production" })).toBeNull();
    expect(() => validateSkillBundleMetadata({ bundleUri: "https://cdn.example.invalid/s" }, { nodeEnv: "production" })).toThrowError(SkillBundleValidationError);
    expect(() => validateSkillBundleMetadata({ bundleUri: "https://cdn.example.invalid/s", bundleDigest: "abc" }, { nodeEnv: "production" })).toThrowError(SkillBundleValidationError);
    expect(validateSkillBundleMetadata({ bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST.toUpperCase() }, { nodeEnv: "production" })).toEqual({
      bundleUri: "https://cdn.example.invalid/s",
      bundleDigest: DIGEST,
    });
  });

  it("requires HTTPS in production and permits only loopback HTTP in development", () => {
    expect(() => validateSkillBundleMetadata({ bundleUri: "http://cdn.example.invalid/s", bundleDigest: DIGEST }, { nodeEnv: "production" })).toThrowError(SkillBundleValidationError);
    expect(validateSkillBundleMetadata({ bundleUri: "http://127.0.0.1:4312/s", bundleDigest: DIGEST }, { nodeEnv: "development" })).not.toBeNull();
    expect(validateSkillBundleMetadata({ bundleUri: "http://[::1]:4312/s", bundleDigest: DIGEST }, { nodeEnv: "development" })).not.toBeNull();
    expect(() => validateSkillBundleMetadata({ bundleUri: "http://192.168.1.2/s", bundleDigest: DIGEST }, { nodeEnv: "development" })).toThrowError(SkillBundleValidationError);
    expect(() => validateSkillBundleMetadata({ bundleUri: "s3://bucket/s", bundleDigest: DIGEST }, { nodeEnv: "development" })).toThrowError(SkillBundleValidationError);
  });

  it("blocks credentials and private/metadata hosts even when the scheme is HTTPS", () => {
    for (const bundleUri of [
      "https://user:pass@cdn.example.invalid/s",
      "https://10.0.0.3/s",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/s",
    ]) {
      expect(() => validateSkillBundleMetadata({ bundleUri, bundleDigest: DIGEST }, { nodeEnv: "production" })).toThrowError(SkillBundleValidationError);
    }
    expect(isPrivateSkillBundleAddress("::ffff:c0a8:101")).toBe(true);
    expect(isPrivateSkillBundleAddress("::ffff:7f00:1")).toBe(true);
  });
});

describe("Skill bundle preflight", () => {
  it("rejects redirects without requesting the redirected/private target", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic },
    )).rejects.toMatchObject({ code: "redirect_not_allowed" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps a dead URL to an unreachable error without leaking the URL", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED https://secret.example.invalid/s"); });
    await expect(preflightSkillBundle(
      { bundleUri: "https://secret.example.invalid/s", bundleDigest: DIGEST },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic },
    )).rejects.toMatchObject({ code: "unreachable", status: 502 });
  });

  it("rejects a digest mismatch", async () => {
    const fetchFn = vi.fn(async () => new Response("not the expected bundle"));
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic },
    )).rejects.toMatchObject({ code: "digest_mismatch", status: 422 });
  });

  it("enforces the streaming 512 KiB body ceiling", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(MAX_SKILL_BUNDLE_BYTES + 1)));
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic },
    )).rejects.toMatchObject({ code: "body_too_large", status: 413 });
  });

  it("returns size and normalized metadata for a matching bundle", async () => {
    const body = "valid skill bundle";
    const digest = createHash("sha256").update(body).digest("hex");
    const fetchFn = vi.fn(async () => new Response(body, { headers: { "content-type": "text/markdown" } }));
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: digest.toUpperCase() },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic },
    )).resolves.toEqual({
      bundleUri: "https://cdn.example.invalid/s",
      bundleDigest: digest,
      size: body.length,
      contentType: "text/markdown",
    });
  });

  it("blocks a hostname that resolves to a private address", async () => {
    const fetchFn = vi.fn(async () => new Response("should not be fetched"));
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST },
      {
        nodeEnv: "production",
        fetchFn,
        lookupFn: vi.fn(async () => [{ address: "192.168.0.7", family: 4 }]),
      },
    )).rejects.toMatchObject({ code: "private_network", status: 400 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a fetch that exceeds the hard timeout", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return await new Promise<Response>(() => undefined);
    });
    await expect(preflightSkillBundle(
      { bundleUri: "https://cdn.example.invalid/s", bundleDigest: DIGEST },
      { nodeEnv: "production", fetchFn, lookupFn: lookupPublic, timeoutMs: 10 },
    )).rejects.toMatchObject({ code: "fetch_timeout", status: 504 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });
});
