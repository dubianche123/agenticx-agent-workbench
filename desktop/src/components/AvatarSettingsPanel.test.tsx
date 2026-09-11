import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Avatar } from "../store";
import { AvatarCreateDialog } from "./AvatarCreateDialog";
import { AvatarSettingsPanel } from "./AvatarSettingsPanel";

function avatar(overrides: Partial<Avatar> = {}): Avatar {
  return {
    id: "avatar-1",
    name: "环境配置专家",
    role: "环境诊断",
    avatarUrl: "",
    description: "帮助团队定位本地环境问题。",
    tags: ["环境", "诊断"],
    pinned: false,
    createdBy: "user",
    defaultPermissionMode: "auto",
    ...overrides,
  };
}

describe("AvatarSettingsPanel", () => {
  it("opens on a contact-style overview with collapsed core-memory cards", () => {
    const html = renderToStaticMarkup(
      <AvatarSettingsPanel
        mode="avatar"
        avatar={avatar()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(html).toContain("专家资料");
    expect(html).toContain("概览");
    expect(html).toContain("数字专家");
    expect(html).toContain("帮助团队定位本地环境问题。");
    expect(html).toContain("编辑资料");
    expect(html).toContain("专家核心记忆");
    expect(html).toContain("IDENTITY.md");
    expect(html).toContain("SOUL.md");
    expect(html).toContain("MEMORY.md");
    expect(html).not.toContain("默认运行模式");
    expect(html).toContain("专家工作区");
    expect(html).toContain("新建会话默认使用这里");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<textarea");
  });

  it("renders an enterprise-managed expert as read-only while keeping its details visible", () => {
    const html = renderToStaticMarkup(
      <AvatarSettingsPanel
        mode="avatar"
        avatar={avatar({ createdBy: "enterprise_managed" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(html).toContain("企业专家");
    expect(html).toContain("查看");
    expect(html).toContain("企业能力包下发的托管专家");
    expect(html).toContain("资料、运行配置与核心记忆均为只读");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("IDENTITY.md");
    expect(html).not.toContain("<textarea");
  });

  it("uses expert terminology in the creation entry", () => {
    const html = renderToStaticMarkup(
      <AvatarCreateDialog
        open
        onClose={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onCreateViaChat={vi.fn()}
      />,
    );

    expect(html).toContain("描述你想要的专家");
    expect(html).toContain("AI 会根据你的需求自动补全名称、签名、角色、标签、运行权限和必要的核心资料");
    expect(html).not.toContain("分身");
  });
});
