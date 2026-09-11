import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  attachmentRoutingCandidates,
  withAttachmentCandidateState,
  type RoutingAdminProvider,
} from "../attachment-routing-admin";

const providers: RoutingAdminProvider[] = [
  {
    id: "local_b",
    displayName: "Local B",
    enabled: true,
    route: "local",
    models: [
      { name: "vl", label: "VL", enabled: true, capabilities: ["vision", "private-deployment"] },
    ],
  },
  {
    id: "cloud_a",
    displayName: "Cloud A",
    enabled: true,
    route: "third-party",
    models: [
      { name: "wrong", label: "Wrong", enabled: true, capabilities: ["vision", "private-deployment"] },
    ],
  },
  {
    id: "private_a",
    displayName: "Private A",
    enabled: true,
    route: "private-cloud",
    models: [
      { name: "vl", label: "VL", enabled: true, capabilities: ["vision", "private-deployment"] },
    ],
  },
];

const routingPageSource = readFileSync(
  new URL("../../app/admin/routing/page.tsx", import.meta.url),
  "utf8",
);
const modelsPageSource = readFileSync(
  new URL("../../app/admin/models/page.tsx", import.meta.url),
  "utf8",
);

describe("attachment routing admin rules", () => {
  it("uses only enabled local candidates and keeps runtime order stable", () => {
    expect(attachmentRoutingCandidates(providers).map((model) => model.id)).toEqual([
      "local_b/vl",
    ]);
  });

  it("adds the two required tags and preserves unrelated capabilities", () => {
    expect(withAttachmentCandidateState(["text"], true)).toEqual([
      "text",
      "vision",
      "private-deployment",
    ]);
    expect(withAttachmentCandidateState(["text", "vision", "private-deployment"], false)).toEqual([
      "text",
      "vision",
    ]);
  });

  it("keeps route classification in model services and public exceptions in capability packs", () => {
    expect(routingPageSource).toContain(
      "providers.filter((provider) => isLocalProviderRoute(provider.route))",
    );
    expect(routingPageSource).toContain("前往模型接入");
    expect(routingPageSource).not.toContain('adminFetch("/api/admin/attachment-routing"');
    expect(routingPageSource).not.toContain("togglePublicOverride");
    expect(routingPageSource).not.toContain("updateProviderRoute");
    expect(routingPageSource).not.toContain("成员是否可以改用公网模型");
    expect(modelsPageSource).toContain(
      'const [routeDraft, setRouteDraft] = useState<ProviderRoute>("third-party")',
    );
    expect(modelsPageSource).toContain("if (routeDraft !== baseline.route) patch.route = routeDraft");
    expect(modelsPageSource).toContain(
      "只有“本地 / 内网”服务会出现在附件处理模型中",
    );
  });
});
