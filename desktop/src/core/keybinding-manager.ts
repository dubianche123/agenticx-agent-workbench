import { VOICE_UI_ENABLED } from "../constants/feature-flags";

export type KeybindingAction =
  | "open-global-search"
  | "open-settings"
  | "clear-messages"
  | "toggle-plan-mode"
  | "toggle-focus-mode"
  | "open-keybindings";

type MatchRule = {
  action: KeybindingAction;
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
};

/**
 * 每条规则都对所有会话生效。
 *
 * 以前每条还带一个 ``mode: "pro" | "lite" | "both"``，配合 ``matchKeybinding(event, userMode)``
 * 做过滤。Lite 早就没了——App 把 userMode 硬写成 "pro"，所以那个字段只有两种结果：
 * "lite" 的规则永远不生效，其余的永远生效。留着它只会让人以为还有第二套界面。
 *
 * ``toggle-mode``（Ctrl/Cmd+Shift+M，切 Pro/Lite）随之删掉：它绑的动作已经是空实现。
 */
const RULES: MatchRule[] = [
  { action: "open-global-search", key: "k", ctrlOrMeta: true },
  { action: "open-settings", key: ",", ctrlOrMeta: true },
  { action: "clear-messages", key: "l", ctrlOrMeta: true },
  { action: "toggle-plan-mode", key: "p", ctrlOrMeta: true, shift: true },
  ...(VOICE_UI_ENABLED
    ? [{ action: "toggle-focus-mode" as const, key: "f", ctrlOrMeta: true, shift: true }]
    : []),
  { action: "open-keybindings", key: "/", ctrlOrMeta: true },
];

/**
 * 输入框聚焦时仍然生效的动作。
 *
 * 全局 keydown 之前会整体跳过 INPUT / TEXTAREA / contenteditable——不然打字会被抢键。
 * 但这几个是**应用级**动作,和文本编辑没有任何冲突(都带 Cmd/Ctrl,其中两个还带
 * Shift),用户最需要它们的时刻恰恰是光标在输入框里：正准备发一条指令,想先切成
 * 只读调研。挡掉之后按键毫无反应,而用户以为自己已经切了模式——和之前那个
 * 假快捷键是同一种失效。
 *
 * 清空消息(Cmd+L)和全局搜索(Cmd+K)不在这里：它们在输入场景里有既有的文本编辑
 * 含义(行首、删到行尾),抢过来是另一种打扰。
 */
export const EDITABLE_SAFE_ACTIONS: ReadonlySet<KeybindingAction> = new Set([
  "toggle-plan-mode",
  "toggle-focus-mode",
  "open-settings",
  "open-keybindings",
]);

export function matchKeybinding(event: KeyboardEvent): KeybindingAction | null {
  const key = event.key.toLowerCase();
  for (const rule of RULES) {
    if (key !== rule.key) continue;
    if (!!rule.ctrlOrMeta !== !!(event.ctrlKey || event.metaKey)) continue;
    if (!!rule.shift !== !!event.shiftKey) continue;
    return rule.action;
  }
  return null;
}
