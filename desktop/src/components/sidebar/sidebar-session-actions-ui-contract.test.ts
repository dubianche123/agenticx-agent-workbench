import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/sidebar/SidebarSessionHistory.tsx"),
  "utf8",
);

describe("sidebar session actions", () => {
  it("only exposes actions supported by the current desktop product", () => {
    expect(source).not.toContain("绑定为飞书会话");
    expect(source).not.toContain("绑定为微信会话");
    expect(source).not.toContain("toggle_feishu_binding");
    expect(source).not.toContain("toggle_wechat_binding");
    expect(source).not.toContain('label="在新标签页打开"');
  });

  it("does not poll removed external IM bindings from the conversation list", () => {
    expect(source).not.toContain("loadFeishuBinding");
    expect(source).not.toContain("loadWechatBinding");
  });

  it("keeps file management in the overflow menu without a duplicate row shortcut", () => {
    expect(source).toContain('label: "文件管理"');
    expect(source).not.toContain('<HoverTip label="文件管理">');
    expect(source).not.toContain('aria-label="文件管理"');
  });
});
