import { describe, expect, it } from "vitest";
import { EDITABLE_SAFE_ACTIONS, matchKeybinding } from "./keybinding-manager";

function ev(key: string, opts: Partial<KeyboardEvent> = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, ...opts } as KeyboardEvent;
}

describe("matchKeybinding", () => {
  it("no longer takes a user mode and resolves every binding for everyone", () => {
    expect(matchKeybinding(ev("k", { ctrlKey: true }))).toBe("open-global-search");
    expect(matchKeybinding(ev("l", { metaKey: true }))).toBe("clear-messages");
    expect(matchKeybinding(ev("/", { ctrlKey: true }))).toBe("open-keybindings");
  });

  it("keeps Ctrl/Cmd+Shift+P bound to the plan toggle", () => {
    expect(matchKeybinding(ev("p", { ctrlKey: true, shiftKey: true }))).toBe("toggle-plan-mode");
    expect(matchKeybinding(ev("p", { ctrlKey: true }))).toBeNull();
  });

  it("drops the retired Pro/Lite toggle", () => {
    expect(matchKeybinding(ev("m", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("EDITABLE_SAFE_ACTIONS", () => {
  it("lets app-level actions through while the cursor is in a text field", () => {
    // 全局 keydown 以前在**匹配之前**整体跳过输入框，于是光标在对话框里按
    // Cmd/Ctrl+Shift+P 毫无反应——而用户以为自己已经切成只读了。用户最需要切模式
    // 的时刻恰恰是正在打字准备发指令的时候。
    expect(EDITABLE_SAFE_ACTIONS.has("toggle-plan-mode")).toBe(true);
    expect(EDITABLE_SAFE_ACTIONS.has("open-settings")).toBe(true);
    expect(EDITABLE_SAFE_ACTIONS.has("open-keybindings")).toBe(true);
  });

  it("keeps the text-editing collisions out", () => {
    // Cmd+L / Cmd+K 在输入场景里有既有含义（行首、删到行尾），抢过来是另一种打扰。
    expect(EDITABLE_SAFE_ACTIONS.has("clear-messages")).toBe(false);
    expect(EDITABLE_SAFE_ACTIONS.has("open-global-search")).toBe(false);
  });
});
