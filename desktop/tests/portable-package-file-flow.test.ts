import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const desktopRoot = process.cwd();
const readSource = (relativePath: string) =>
  fs.readFileSync(path.resolve(desktopRoot, relativePath), "utf8");

describe("portable package local-file contract", () => {
  it("writes only the package envelope with distinct expert/group suffixes", () => {
    const source = readSource("electron/main.ts");

    expect(source).toContain('expert: ".agx-expert.json"');
    expect(source).toContain('group: ".agx-group.json"');
    expect(source).toContain("JSON.stringify(body.package, null, 2)");
    expect(source).toContain("body: JSON.stringify(safeExportRequest)");
    expect(source).toContain("normalizePortablePackagePublication(body.package, kind)");
    expect(source).not.toContain("JSON.stringify(body, null, 2)");
  });

  it("bounds and validates the selected file while preserving raw JSON for Studio", () => {
    const source = readSource("electron/main.ts");

    expect(source).toContain("const PORTABLE_PACKAGE_MAX_BYTES = 256 * 1024");
    expect(source).toContain("await fs.promises.lstat(filePath)");
    expect(source).toContain("!stat.isFile() || stat.isSymbolicLink()");
    expect(source).toContain("Buffer.alloc(PORTABLE_PACKAGE_MAX_BYTES + 1)");
    expect(source).toContain("while (totalBytesRead < bounded.length)");
    expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(source).toContain("body: JSON.stringify({ raw: rawText })");
    expect(source).toContain("confirmation_token: confirmationToken");
    expect(source).not.toContain("apiPayload = { package: packageEnvelope }");
    expect(source).toContain("previewKind !== fileKind");
  });

  it("exposes import and export actions in both Desktop galleries", () => {
    const experts = readSource("src/components/gallery/AvatarGalleryView.tsx");
    const groups = readSource("src/components/groups/ProjectsView.tsx");

    expect(experts).toContain('choosePortablePackageFile("expert")');
    expect(experts).toContain('kind: "expert"');
    expect(experts).toContain("导入专家");
    expect(experts).toContain("导出分享文件");
    expect(groups).toContain('choosePortablePackageFile("group")');
    expect(groups).toContain('kind: "group"');
    expect(groups).toContain("导入群聊");
    expect(groups).toContain("PortablePackageImportDialog");
  });

  it("creates same-company links in the main process without exposing the PAT", () => {
    const main = readSource("electron/main.ts");
    const preload = readSource("electron/preload.ts");
    const experts = readSource("src/components/gallery/AvatarGalleryView.tsx");
    const groups = readSource("src/components/groups/ProjectsView.tsx");

    expect(main).toContain('`${portalOrigin}/api/desktop/config-shares`');
    expect(main).toContain("authorization: `Bearer ${token}`");
    expect(main).toContain("trustedPortableShareUrl(result.data?.path, portalOrigin)");
    expect(main).toContain("clipboard.writeText(shareUrl)");
    expect(main).toContain("const publication = normalizePortablePackagePublication(exported.package, kind)");
    expect(main).toContain("body: JSON.stringify(publication)");
    expect(main).not.toContain("manifest_version: 1");
    expect(preload).toContain("createPortablePackageShareLink");
    expect(preload).not.toContain("authorization: `Bearer");
    expect(experts).toContain("复制公司链接");
    expect(groups).toContain("handleShareGroupLink");
  });

  it("keeps company-market PAT access in the main process and reuses inspected import", () => {
    const main = readSource("electron/main.ts");
    const preload = readSource("electron/preload.ts");
    const experts = readSource("src/components/gallery/AvatarGalleryView.tsx");
    const groups = readSource("src/components/groups/ProjectsView.tsx");
    const plaza = readSource("src/components/portable/DigitalExpertPlazaView.tsx");

    expect(main).toContain('"publish-portable-package-to-market"');
    expect(main).toContain('"list-portable-package-market"');
    expect(main).toContain('"inspect-portable-package-market-item"');
    expect(main).toContain('`${auth.portalOrigin}/api/desktop/config-market`');
    expect(main).toContain("inspectPortablePackageRaw(raw, expectedKind)");
    expect(main).toContain("normalizePortableMarketReleaseNotes(request.release_notes)");
    expect(main).toContain("...(outgoingReleaseNotes ? { release_notes: outgoingReleaseNotes } : {})");
    expect(preload).toContain("publishPortablePackageToMarket");
    expect(preload).toContain("listPortablePackageMarket");
    expect(preload).not.toContain("auth.token");
    expect(experts).toContain("发布到公司市场");
    expect(groups).toContain("handlePublishGroup");
    expect(plaza).toContain('kind: "expert"');
    expect(plaza).toContain('kind: "group"');
    expect(plaza).toContain("inspectPortablePackageMarketItem");
    expect(plaza).toContain("item.kind");
  });

  it("sends the exact market envelope after optional redaction", () => {
    const main = readSource("electron/main.ts");
    const portalAt = main.indexOf('`${auth.portalOrigin}/api/desktop/config-market`');
    const requestBodyAt = main.indexOf("body: JSON.stringify({", portalAt);
    const requestBody = main.slice(requestBodyAt, main.indexOf('redirect: "error"', requestBodyAt));

    expect(requestBody).toContain("manifest: publication.manifest");
    expect(requestBody).toContain("release_notes: outgoingReleaseNotes");
    expect(requestBody).toContain("visibility: {");
    expect(requestBody).not.toMatch(/^\s*\.\.\.publication,/m);
    expect(requestBody).not.toMatch(/^\s*(?:kind|manifest_version)\s*:/m);
  });

  it("preflights package and release-note findings before any Portal request", () => {
    const main = readSource("electron/main.ts");
    const publishAt = main.indexOf('"publish-portable-package-to-market"');
    const localScanAt = main.indexOf("scanPortableMarketText(releaseNotes", publishAt);
    const portalAt = main.indexOf('`${auth.portalOrigin}/api/desktop/config-market`', publishAt);
    expect(main).toContain("allow_scan_findings: true");
    expect(main).toContain("isPortablePackageScanReport(exported.scan_report)");
    expect(main).toContain("normalizePortablePackageScanFindings(exported.scan_report)");
    expect(main).toContain("scanPortableMarketManifest(packageValue)");
    expect(localScanAt).toBeGreaterThan(publishAt);
    expect(portalAt).toBeGreaterThan(localScanAt);
    expect(main.slice(localScanAt, portalAt)).toContain("发布前发现敏感信息");
  });

  it("forwards and returns the opaque market page cursor", () => {
    const main = readSource("electron/main.ts");
    const preload = readSource("electron/preload.ts");
    const types = readSource("src/global.d.ts");

    expect(main).toContain('url.searchParams.set("limit", String(limit))');
    expect(main).toContain('url.searchParams.set("cursor", cursor)');
    expect(main).toContain("next_cursor?: unknown");
    expect(main).toContain("nextCursor,");
    expect(preload).toContain("cursor?: string;");
    expect(types).toContain("nextCursor?: string | null;");
  });

  it("reconciles managed Skills locally and forwards only expert/group desired state", () => {
    const main = readSource("electron/main.ts");

    expect(main).toContain('"/api/portable-packages/managed/reconcile"');
    expect(main).toContain("normalizeManagedPortableReconcilePayload(value)");
    expect(main).toContain('reconcilePayload.packages.filter((item) => item.id.startsWith("skill:"))');
    expect(main).toContain('reconcilePayload.packages.filter((item) => !item.id.startsWith("skill:"))');
    expect(main).toContain("reconcileManagedMarketSkills(skillPackages)");
    expect(main).toContain("const runtimePayload = { packages: runtimePackages }");
    expect(main).toContain("body: JSON.stringify(runtimePayload)");
    expect(main).toContain("已保留本机现状");
    expect(main).toContain("bootJson.data?.managedPortablePackages");
    expect(main).toContain("reconcileManagedPortablePackages([])");
  });

  it("records the release locally only after a successful market response", () => {
    const main = readSource("electron/main.ts");
    const portalRequestAt = main.indexOf('`${auth.portalOrigin}/api/desktop/config-market`');
    const portalSuccessCheckAt = main.indexOf("if (!response.ok)", portalRequestAt);
    const markPublishedAt = main.indexOf('"/api/portable-packages/mark-published"');

    expect(portalRequestAt).toBeGreaterThan(-1);
    expect(portalSuccessCheckAt).toBeGreaterThan(portalRequestAt);
    expect(markPublishedAt).toBeGreaterThan(portalSuccessCheckAt);
    expect(main).toContain("release_version: publication.manifest.release_version");
    expect(main).toContain("市场发布已成功，但");
    expect(main.match(/\/api\/portable-packages\/mark-published/g)).toHaveLength(1);
  });
});
