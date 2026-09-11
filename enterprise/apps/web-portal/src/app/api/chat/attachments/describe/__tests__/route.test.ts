import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuthFromCookies: vi.fn(),
  listAvailableModelsForUser: vi.fn(),
  isPlatformFeatureAllowedOnSurface: vi.fn(),
  describeImages: vi.fn(),
  putOriginal: vi.fn(),
}));

vi.mock("../../../../../../lib/session", () => ({
  getSessionAuthFromCookies: mocks.getSessionAuthFromCookies,
  passwordChangeRequiredResponse: () => Response.json({}, { status: 403 }),
}));
vi.mock("../../../../../../lib/admin-providers-reader", () => ({
  listAvailableModelsForUser: mocks.listAvailableModelsForUser,
}));
vi.mock("../../../../../../lib/capability-packs-reader", () => ({
  isPlatformFeatureAllowedOnSurface: mocks.isPlatformFeatureAllowedOnSurface,
}));
vi.mock("../../../../../../lib/attachments/original-store", () => ({
  MAX_ORIGINAL_RETAIN_BYTES: 50 * 1024 * 1024,
  defaultOriginalStore: { put: mocks.putOriginal },
}));
vi.mock("../../../../../../lib/image-understanding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../lib/image-understanding")>();
  return { ...actual, describeImages: mocks.describeImages };
});

import { POST } from "../route";

const auth = {
  session: {
    userId: "user-1",
    tenantId: "tenant-1",
    deptId: "dept-1",
    email: "user@example.com",
    mustChangePassword: false,
    sessionId: "auth-session-1",
  },
  accessToken: "access-token",
  refreshToken: null,
};

function request(): Request {
  const form = new FormData();
  form.append("model", "custom_openai_moma/ZHIPU/GLM-5.2");
  form.append("files", new Blob(["png"], { type: "image/png" }), "screen.png");
  return new Request("http://localhost/api/chat/attachments/describe", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/chat/attachments/describe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionAuthFromCookies.mockResolvedValue(auth);
    mocks.isPlatformFeatureAllowedOnSurface.mockResolvedValue(true);
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "custom_openai_moma/ZHIPU/GLM-5.2",
        provider: "custom_openai_moma",
        model: "ZHIPU/GLM-5.2",
        route: "third-party",
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen2.5-vl",
        provider: "qwen-local",
        model: "qwen2.5-vl",
        label: "Private Qwen VL",
        route: "local",
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    mocks.describeImages.mockResolvedValue([
      {
        name: "screen.png",
        dataUrl: "data:image/png;base64,cG5n",
        text: "图片文字为测试",
        contextText: "[图片解读：screen.png]\n图片文字为测试",
        mode: "vision",
      },
    ]);
    mocks.putOriginal.mockResolvedValue({ id: "01HYAAAAAAAAAAAAAAAAAAAAB2" });
  });

  it("returns persistent text context and an original-image id", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        attachments: [
          {
            name: "screen.png",
            kind: "image",
            parsed_text: "[图片解读：screen.png]\n图片文字为测试",
            attachment_id: "01HYAAAAAAAAAAAAAAAAAAAAB2",
          },
        ],
      },
    });
    expect(mocks.describeImages).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "screen.png", dataUrl: "data:image/png;base64,cG5n" })],
      expect.objectContaining({
        fallback: expect.objectContaining({ provider: "qwen-local", model: "qwen2.5-vl" }),
      }),
    );
    expect(mocks.putOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", fileName: "screen.png" }),
    );
  });

  it("fails closed when no private vision fallback is configured", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "custom_openai_moma/ZHIPU/GLM-5.2",
        provider: "custom_openai_moma",
        model: "ZHIPU/GLM-5.2",
        route: "third-party",
        capabilities: ["text"],
      },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "40002" } });
    expect(mocks.describeImages).not.toHaveBeenCalled();
  });
});
