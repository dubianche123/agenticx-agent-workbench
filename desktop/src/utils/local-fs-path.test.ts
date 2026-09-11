import { describe, expect, it } from "vitest";

import { decodePercentEncodedLocalPath, pickLocalFsPathCandidate } from "./local-fs-path";
import { resolveRelativeAssetPath } from "./workspace-file-path";

const REAL_PATH = "/Users/test/taskspaces/推演报告/推文/img/01-循环融资链条.svg";
const ENCODED_PATH = encodeURI(REAL_PATH);

describe("decodePercentEncodedLocalPath", () => {
  it("decodes encoded CJK, spaces, and hashes", () => {
    expect(decodePercentEncodedLocalPath(ENCODED_PATH)).toBe(REAL_PATH);
    expect(decodePercentEncodedLocalPath("/tmp/foo%20bar%23baz.svg")).toBe(
      "/tmp/foo bar#baz.svg",
    );
  });

  it("does not create separators or traversal segments", () => {
    expect(decodePercentEncodedLocalPath("/tmp/a%2F..%2Fsecret.svg")).toBe(
      "/tmp/a%2F..%2Fsecret.svg",
    );
    expect(decodePercentEncodedLocalPath("/tmp/%2e%2e/secret.svg")).toBe(
      "/tmp/%2e%2e/secret.svg",
    );
  });

  it("leaves remote, bundled, malformed, and already decoded paths unchanged", () => {
    expect(decodePercentEncodedLocalPath("https://example.com/%E4%B8%AD.png")).toBe(
      "https://example.com/%E4%B8%AD.png",
    );
    expect(decodePercentEncodedLocalPath("/assets/logo.svg")).toBe("/assets/logo.svg");
    expect(decodePercentEncodedLocalPath("/tmp/a%zz.svg")).toBe("/tmp/a%zz.svg");
    expect(decodePercentEncodedLocalPath(REAL_PATH)).toBe(REAL_PATH);
  });

  it("supports file URLs and Windows paths", () => {
    expect(decodePercentEncodedLocalPath(`file://${ENCODED_PATH}`)).toBe(`file://${REAL_PATH}`);
    expect(decodePercentEncodedLocalPath("C:/Users/%E6%8E%A8%E6%BC%94/a.svg")).toBe(
      "C:/Users/推演/a.svg",
    );
  });
});

describe("pickLocalFsPathCandidate", () => {
  it("preserves a real literal percent-encoded filename", () => {
    const literal = "/tmp/01-%E5%BE%AA.svg";
    expect(pickLocalFsPathCandidate(literal, (path) => path === literal)).toBe(literal);
  });

  it("uses the decoded path when the literal path does not exist", () => {
    expect(pickLocalFsPathCandidate(ENCODED_PATH, () => false)).toBe(REAL_PATH);
  });
});

describe("resolveRelativeAssetPath", () => {
  it("decodes an encoded relative image before joining it to the host file", () => {
    expect(
      resolveRelativeAssetPath(
        "/Users/test/taskspaces/推演报告/推文/report.md",
        "img/01-%E5%BE%AA%E7%8E%AF%E8%9E%8D%E8%B5%84%E9%93%BE%E6%9D%A1.svg",
      ),
    ).toBe(REAL_PATH);
  });
});
