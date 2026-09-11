import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (fileName: string) =>
  fs.readFileSync(path.resolve(process.cwd(), "src/components/groups", fileName), "utf8");

describe("group management UI contract", () => {
  it("keeps member actions separate from deleting the group", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain("移出成员");
    expect(source).toContain("编辑成员");
    expect(source).toContain("onEditMember");
    expect(source).toContain("删除群聊");
    expect(source).toContain("添加成员");
    expect(source).not.toContain("选择分身");
  });

  it("makes the group host an explicit persisted choice", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain('type="radio"');
    expect(source).toContain('name="group-host"');
    expect(source).toContain("host_avatar_id: normalizedHostAvatarId");
    expect(source).toContain("选择 1 位成员担任主持人");
    expect(source).not.toContain("启用主持人");
  });

  it("starts new groups with the visible product meta-agent as host", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain("initialGroup?.avatarIds ?? [GROUP_META_MEMBER_ID]");
    expect(source).toContain("initialGroup?.avatarIds[0] || GROUP_META_MEMBER_ID");
    expect(source).toContain("${META_AGENT_DISPLAY_NAME}默认加入并主持");
    expect(source).toContain("removeMember(id)");
    expect(source).not.toContain("主持人必选");

    const editIndex = source.indexOf("aria-label={`编辑成员 ${label}`}");
    const hostIndex = source.indexOf('name="group-host"');
    const removeIndex = source.indexOf("aria-label={`移出成员 ${label}`}");
    expect(editIndex).toBeGreaterThan(-1);
    expect(editIndex).toBeLessThan(hostIndex);
    expect(hostIndex).toBeLessThan(removeIndex);
    expect(source).toContain("sm:grid-cols-[5rem_7.25rem_5rem]");
  });

  it("routes member editing through the avatar gallery settings target", () => {
    const projectsSource = readSource("ProjectsView.tsx");
    const gallerySource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/gallery/AvatarGalleryView.tsx"),
      "utf8",
    );

    expect(projectsSource).toContain("setAvatarSettingsTargetId(avatarId)");
    expect(projectsSource).toContain('setMainView("avatars")');
    expect(gallerySource).toContain("avatarSettingsTargetId");
    expect(gallerySource).toContain("setSettingsAvatarId(targetExists ? avatarSettingsTargetId : null)");
    expect(gallerySource).toContain("setAvatarSettingsTargetId(null)");
  });

  it("opens unmanaged settings directly and makes managed settings explicitly read-only", () => {
    const source = readSource("ProjectsView.tsx");
    const editorSource = readSource("GroupEditorInline.tsx");

    expect(source).not.toContain("setSelectedTemplate");
    expect(source).toContain('label: menuGroup.createdBy === "enterprise_managed" ? "群聊设置（只读）" : "群聊设置"');
    expect(source).toContain('setEditorState({ mode: "edit", group });');
    expect(editorSource).toContain("这是企业能力包下发的托管群聊，不能直接修改");
    expect(editorSource).toContain("群聊详情（只读）");
  });

  it("presents an existing group as a contact-style profile before management", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain("function GroupProfileOverview");
    expect(source).toContain('const isProfileView = Boolean(initialGroup && !managementOpen)');
    expect(source).toContain('visibleTitle = isProfileView ? "群资料" : title');
    expect(source).toContain("群简介");
    expect(source).toContain("共享工作区");
    expect(source).toContain("进入群聊");
    expect(source).toContain('aria-label="返回群资料"');
    expect(source).toContain("管理成员");
  });

  it("exposes persisted group profile, portrait, and shared workspace controls", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain("选择群头像");
    expect(source).toContain("恢复默认");
    expect(source).toContain("群共享工作区");
    expect(source).toContain("选择文件夹");
    expect(source).toContain("description: description.trim()");
    expect(source).toContain("avatar_url: avatarUrlDraft.trim()");
    expect(source).toContain("workspace_dir: workspaceDir.trim()");
    expect(source).toContain("window.agenticxDesktop.chooseDirectory");
  });

  it("edits profile fields in the details view and keeps one group description concept", () => {
    const source = readSource("GroupEditorInline.tsx");

    expect(source).toContain("onDescriptionChange");
    expect(source).toContain("onPickAvatarImage");
    expect(source).toContain("onChooseWorkspace");
    expect(source).toContain("保存群聊设置");
    expect(source).not.toContain("编辑群资料");
    expect(source).not.toContain("群签名");
    expect(source).toContain("{!initialGroup ? (");
  });

  it("opens group details from the card body while keeping chat actions explicit", () => {
    const source = readSource("ProjectsView.tsx");

    expect(source).toContain("const handleOpenGroupDetails = (group: GroupChat)");
    expect(source).toContain('onClick={() => handleOpenGroupDetails(group)}');
    expect(source).toContain('aria-label={`打开群聊详情：${group.name}`}');
    expect(source).toContain('onClick={() => openGroupPane(group)}');
    expect(source).toContain("onOpenChat=");
    expect(source).toContain("openGroupPane(editorState.group)");
    expect(source).not.toContain("newGroupConversation");
    expect(source).not.toContain('onClick={() => openGroupPane(group)}\n                    aria-label={`${primaryActionLabel}：${group.name}`}');
    expect(source).toContain("前往专家广场添加官方团队模板");
  });

  it("keeps managed group membership mutations fail-closed in the workbench", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/work-panel/GroupMembersSummaryList.tsx"),
      "utf8",
    );

    expect(source).toContain('const isManaged = group.createdBy === "enterprise_managed"');
    expect(source).toContain("if (isManaged) {");
    expect(source).toContain("{!isManaged ? (");
    expect(source).toContain("{addOpen && !isManaged ? (");
    expect(source).toContain("成员由管理员通过能力包统一维护");
  });

  it("exposes continue and manage actions on persistent group cards", () => {
    const source = readSource("ProjectsView.tsx");

    expect(source).toContain('const primaryActionLabel = "进入群聊"');
    expect(source).toContain("持久群聊");
    expect(source).not.toContain("countGroupSessionsByAvatar");
    expect(source).not.toContain("个对话");
    expect(source).toContain("管理");
    expect(source).toContain("GroupMemberStack");
    expect(source).not.toContain("点击卡片打开对话");
    expect(source).not.toContain("打开一个团队继续对话");
  });

  it("keeps conversation actions on one row and moves sharing into the management menu", () => {
    const source = readSource("ProjectsView.tsx");

    expect(source).toContain("ContextMenu");
    expect(source).toContain("const groupMenuItems");
    expect(source).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(source).toContain("whitespace-nowrap");
    expect(source).toContain("导出分享文件");
    expect(source).toContain("复制公司链接");
    expect(source).toContain("发布到公司市场");
    expect(source).toContain("result.notice || result.warning");
    expect(source).not.toContain("pointer-events-none absolute inset-y-0");
    expect(source).not.toContain("aria-label={`导出${group.name}分享文件`}");
  });

  it("uses available content width instead of viewport breakpoints for project grids", () => {
    const source = readSource("ProjectsView.tsx");

    expect(source).toContain('gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))"');
    expect(source).not.toContain("sm:grid-cols-2 xl:grid-cols-3");
  });

  it("keeps compact group member avatars separated instead of overlapping", () => {
    const source = readSource("ProjectsView.tsx");

    expect(source).toContain('className="flex shrink-0 items-center gap-2"');
    expect(source).toContain('size="xs"');
    expect(source).not.toContain('className={index === 0 ? "" : "-ml-2"}');
  });

  it("uses stable icon identities instead of text monograms for defaults", () => {
    const source = readSource("GroupMemberAvatar.tsx");

    expect(source).toContain("MEMBER_ICON_SET");
    expect(source).toContain("stableIndex");
    expect(source).toContain("safeGroupAvatarUrl");
    expect(source).toContain('["http:", "https:"].includes(parsed.protocol)');
    expect(source).toContain('parsed.username || parsed.password');
    expect(source).not.toContain("memberInitials");
  });
});
