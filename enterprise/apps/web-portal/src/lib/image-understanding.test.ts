import { describe, expect, it, vi } from "vitest";

import {
  countImageParts,
  describeImages,
  replaceImagePartsWithDescriptions,
} from "./image-understanding";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function ok(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function options(fetchImpl: typeof fetch) {
  return {
    gatewayUrl: "http://gateway.test/v1/chat/completions",
    headers: {
      authorization: "Bearer token",
      "x-agenticx-provider": "selected-text-provider",
    },
    fallback: {
      id: "qwen-local/qwen-vl",
      provider: "qwen-local",
      model: "qwen-vl",
      label: "Private Qwen VL",
    },
    fetchImpl,
  };
}

describe("image-understanding", () => {
  it("uses the private fallback without switching the target model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok("报错代码 1210"));
    const [result] = await describeImages(
      [{ name: "error.png", dataUrl: PNG }],
      options(fetchImpl),
    );

    expect(result?.mode).toBe("vision");
    expect(result?.contextText).toContain("报错代码 1210");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["x-agenticx-provider"]).toBe("qwen-local");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    expect(body.model).toBe("qwen-vl");
    expect(body.messages[0]?.content[0]?.text).toContain("逐字转录");
  });

  it("retries in OCR-only mode when normal vision parsing is empty", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok([{ type: "text", text: "测试两个字" }]));

    const [result] = await describeImages(
      [{ name: "screen.png", dataUrl: PNG }],
      options(fetchImpl),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result?.mode).toBe("ocr-retry");
    expect(result?.text).toBe("测试两个字");
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(secondBody.messages[0]?.content[0]?.text).toContain("OCR");
  });

  it("flattens image_url blocks to text for a non-vision target", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok("界面上显示参数非法"));
    const input = {
      model: "GLM-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "这是什么问题？" },
            { type: "image_url", image_url: { url: PNG } },
          ],
        },
      ],
    };

    expect(countImageParts(input)).toBe(1);
    const transformed = await replaceImagePartsWithDescriptions(
      input,
      options(fetchImpl),
    );

    expect(transformed.model).toBe("GLM-5.2");
    expect(countImageParts(transformed)).toBe(0);
    const content = (transformed.messages as Array<{ content: string }>)[0]?.content;
    expect(content).toContain("这是什么问题？");
    expect(content).toContain("界面上显示参数非法");
  });

  it("rejects more images than Desktop's per-turn fallback limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      describeImages(
        Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, dataUrl: PNG })),
        options(fetchImpl),
      ),
    ).rejects.toThrow("最多自动解析 4 张图片");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
