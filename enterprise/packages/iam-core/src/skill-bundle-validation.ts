import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** The maximum URI the Skill registry accepts and the maximum body it fetches. */
export const MAX_SKILL_BUNDLE_URI_LENGTH = 2_048;
export const MAX_SKILL_BUNDLE_BYTES = 512 * 1024;
export const SKILL_BUNDLE_FETCH_TIMEOUT_MS = 15_000;

export type SkillBundleValidationErrorCode =
  | "invalid_uri"
  | "invalid_digest"
  | "missing_pair"
  | "private_network"
  | "fetch_timeout"
  | "unreachable"
  | "redirect_not_allowed"
  | "http_error"
  | "body_too_large"
  | "digest_mismatch";

/** A safe, machine-readable error that callers can map to their own HTTP API. */
export class SkillBundleValidationError extends Error {
  public readonly code: SkillBundleValidationErrorCode;
  public readonly status: number;

  public constructor(
    code: SkillBundleValidationErrorCode,
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "SkillBundleValidationError";
    this.code = code;
    this.status = status;
  }
}

export type SkillBundleMetadataInput = {
  bundleUri?: unknown;
  bundleDigest?: unknown;
};

export type ValidSkillBundleMetadata = {
  bundleUri: string;
  /** Lowercase 64-character SHA-256 hexadecimal digest. */
  bundleDigest: string;
};

export type SkillBundleValidationOptions = {
  /** Defaults to NODE_ENV. Any value other than production enables loopback HTTP. */
  nodeEnv?: string;
  /** Explicitly override the development loopback rule in tests or an embedding service. */
  allowLoopbackHttp?: boolean;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family === 4) return host === "127.0.0.1" || host.startsWith("127.");
  if (family !== 6) return false;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const groups = expandIpv6(host);
  return Boolean(
    groups &&
      groups.slice(0, 5).every((group) => group === 0) &&
      groups[5] === 0xffff &&
      ((groups[6] ?? 0) >> 8) === 127,
  );
}

function ipv4IsPrivate(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function expandIpv6(host: string): number[] | null {
  let value = host.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = value.slice(separator + 1);
    if (!isIP(ipv4)) return null;
    const octets = ipv4.split(".").map(Number);
    value = `${value.slice(0, separator)}:${((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function ipv6IsPrivate(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups) return false;
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = first === 0 && groups.slice(1, 7).every((group) => group === 0) && groups[7] === 1;
  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && (groups[5] ?? 0) === 0xffff;
  if (isIpv4Mapped) {
    const mappedIpv4 = [
      (groups[6] ?? 0) >> 8,
      (groups[6] ?? 0) & 0xff,
      (groups[7] ?? 0) >> 8,
      (groups[7] ?? 0) & 0xff,
    ].join(".");
    return ipv4IsPrivate(mappedIpv4);
  }
  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 || // RFC 4193 unique-local
    (first & 0xffc0) === 0xfe80 || // RFC 4291 link-local
    (first & 0xff00) === 0xff00 || // multicast/reserved
    (first === 0 && second === 0 && (groups[2] ?? 0) === 0 && (groups[3] ?? 0) === 0 && (groups[4] ?? 0) === 0 && (groups[5] ?? 0) === 0xffff && (groups[6] ?? 0) < 256) // mapped 0/8; mapped private ranges are handled below
  );
}

/** Covers literal private/link-local/metadata ranges before any network I/O. */
export function isPrivateSkillBundleAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) return ipv4IsPrivate(host);
  if (family !== 6) {
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "local" ||
      host.endsWith(".local") ||
      host === "metadata" ||
      host === "metadata.google.internal" ||
      host.endsWith(".metadata.google.internal")
    );
  }
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    if (isIP(mapped) === 4) return ipv4IsPrivate(mapped);
  }
  return ipv6IsPrivate(host);
}

function allowLoopbackHttp(options: SkillBundleValidationOptions): boolean {
  return options.allowLoopbackHttp ?? (options.nodeEnv ?? process.env.NODE_ENV) !== "production";
}

function parseSafeBundleUri(value: unknown, options: SkillBundleValidationOptions): string {
  const uri = text(value);
  if (!uri || [...uri].length > MAX_SKILL_BUNDLE_URI_LENGTH) {
    throw new SkillBundleValidationError("invalid_uri", "bundleUri must be a non-empty URI of at most 2048 characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new SkillBundleValidationError("invalid_uri", "bundleUri is not a valid URL");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new SkillBundleValidationError("invalid_uri", "bundleUri must use HTTPS");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new SkillBundleValidationError("invalid_uri", "bundleUri must not contain credentials or a fragment");
  }
  const loopbackHttp = protocol === "http:" && allowLoopbackHttp(options) && isLoopbackHostname(parsed.hostname);
  if (protocol === "http:" && !loopbackHttp) {
    throw new SkillBundleValidationError("invalid_uri", "HTTP bundleUri is allowed only for loopback development URLs");
  }
  if (isPrivateSkillBundleAddress(parsed.hostname) && !loopbackHttp) {
    throw new SkillBundleValidationError("private_network", "bundleUri targets a private or local network");
  }
  return parsed.toString();
}

/**
 * Validate the metadata pair used by Skill create/update APIs. Empty pair means
 * a Skill without a downloadable bundle; a URI and digest must always travel
 * together so a later write cannot create an unverifiable bundle.
 */
export function validateSkillBundleMetadata(
  input: SkillBundleMetadataInput,
  options: SkillBundleValidationOptions = {},
): ValidSkillBundleMetadata | null {
  const rawUri = text(input.bundleUri);
  const rawDigest = text(input.bundleDigest);
  if (!rawUri && !rawDigest) return null;
  if (!rawUri || !rawDigest) {
    throw new SkillBundleValidationError(
      "missing_pair",
      "bundleUri and bundleDigest must be provided together",
    );
  }
  const bundleUri = parseSafeBundleUri(rawUri, options);
  if (!/^[0-9a-f]{64}$/i.test(rawDigest)) {
    throw new SkillBundleValidationError(
      "invalid_digest",
      "bundleDigest must be exactly 64 hexadecimal SHA-256 characters",
    );
  }
  return { bundleUri, bundleDigest: rawDigest.toLowerCase() };
}

export const assertSkillBundleMetadata = validateSkillBundleMetadata;

type DnsAddress = { address: string; family?: number };
export type SkillBundlePreflightOptions = SkillBundleValidationOptions & {
  fetchFn?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<readonly DnsAddress[]>;
  timeoutMs?: number;
};

export type SkillBundlePreflightResult = ValidSkillBundleMetadata & {
  size: number;
  contentType: string | null;
};

function preflightError(
  code: SkillBundleValidationErrorCode,
  message: string,
  status: number,
): SkillBundleValidationError {
  return new SkillBundleValidationError(code, message, status);
}

async function verifyResolvedAddresses(
  hostname: string,
  options: SkillBundlePreflightOptions,
  loopbackHttp: boolean,
): Promise<void> {
  if (isIP(hostname) || loopbackHttp) return;
  const lookupFn = options.lookupFn ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  // Native fetch performs its own lookup after this check. `redirect: manual`
  // closes the redirect-to-private-host bypass; deployments needing protection
  // from DNS rebinding should additionally pin resolution in their egress proxy.
  try {
    const addresses = await lookupFn(hostname);
    if (addresses.some((entry) => isPrivateSkillBundleAddress(entry.address))) {
      throw preflightError("private_network", "bundleUri resolves to a private or local network", 400);
    }
  } catch (error) {
    // Preserve a deliberate private-network rejection; ordinary DNS failure is
    // handled by the fetch below and returned as an unreachable bundle.
    if (error instanceof SkillBundleValidationError) throw error;
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw preflightError("body_too_large", "Skill bundle exceeds the 512 KiB limit", 413);
    }
  }
  if (!response.body) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.byteLength > maxBytes) {
      throw preflightError("body_too_large", "Skill bundle exceeds the 512 KiB limit", 413);
    }
    return value;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw preflightError("http_error", "Skill bundle returned an invalid body", 502);
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw preflightError("body_too_large", "Skill bundle exceeds the 512 KiB limit", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Fetch and verify a Skill bundle without following redirects or buffering an
 * unbounded response. The fetch function is injectable for deterministic API
 * tests; production callers should use the default Node fetch.
 */
export async function preflightSkillBundle(
  input: SkillBundleMetadataInput,
  options: SkillBundlePreflightOptions = {},
): Promise<SkillBundlePreflightResult> {
  const metadata = validateSkillBundleMetadata(input, options);
  if (!metadata) {
    throw new SkillBundleValidationError(
      "missing_pair",
      "bundleUri and bundleDigest are required for preflight",
    );
  }
  const parsed = new URL(metadata.bundleUri);
  const loopbackHttp = parsed.protocol === "http:" && allowLoopbackHttp(options) && isLoopbackHostname(parsed.hostname);
  const timeoutMs = Math.min(
    SKILL_BUNDLE_FETCH_TIMEOUT_MS,
    Math.max(1, Math.floor(options.timeoutMs ?? SKILL_BUNDLE_FETCH_TIMEOUT_MS)),
  );
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: ((reason: SkillBundleValidationError) => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout?.(preflightError("fetch_timeout", "Skill bundle request timed out", 504));
  }, timeoutMs);
  try {
    const workPromise = (async (): Promise<SkillBundlePreflightResult> => {
        await verifyResolvedAddresses(parsed.hostname, options, loopbackHttp);
        const fetchFn = options.fetchFn ?? fetch;
        let response: Response;
        try {
          response = await fetchFn(metadata.bundleUri, {
            method: "GET",
            redirect: "manual",
            headers: { accept: "application/octet-stream, text/plain;q=0.9, */*;q=0.1" },
            signal: controller.signal,
          });
        } catch {
          if (timedOut || controller.signal.aborted) {
            throw preflightError("fetch_timeout", "Skill bundle request timed out", 504);
          }
          throw preflightError("unreachable", "Skill bundle could not be reached", 502);
        }
        if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
          await response.body?.cancel().catch(() => undefined);
          throw preflightError("redirect_not_allowed", "Skill bundle redirects are not allowed", 400);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw preflightError("http_error", "Skill bundle returned a non-success response", 502);
        }
        const body = await readBoundedBody(response, MAX_SKILL_BUNDLE_BYTES);
        if (timedOut || controller.signal.aborted) {
          throw preflightError("fetch_timeout", "Skill bundle request timed out", 504);
        }
        const digest = createHash("sha256").update(body).digest("hex");
        if (digest !== metadata.bundleDigest) {
          throw preflightError("digest_mismatch", "Skill bundle SHA-256 digest does not match", 422);
        }
        return {
          ...metadata,
          size: body.byteLength,
          contentType: response.headers.get("content-type"),
        };
      })();
    // A custom fetch/lookup used by an embedding service might ignore AbortSignal;
    // attach a rejection handler so it cannot become an unhandled rejection after
    // the hard timeout has already won the race.
    void workPromise.catch(() => undefined);
    return await Promise.race([workPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof SkillBundleValidationError) throw error;
    if (timedOut || controller.signal.aborted) {
      throw preflightError("fetch_timeout", "Skill bundle request timed out", 504);
    }
    throw preflightError("unreachable", "Skill bundle could not be reached", 502);
  } finally {
    clearTimeout(timer);
  }
}
