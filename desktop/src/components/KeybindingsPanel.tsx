import { VOICE_UI_ENABLED } from "../constants/feature-flags";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * 快捷键说明。以前分 PRO / LITE 两份清单——Lite 界面已经删掉，只剩一份。
 *
 * 列表必须跟 ``core/keybinding-manager.ts`` 的 RULES 对得上：这里写着但实际没绑
 * （或绑了却没人消费）的快捷键，比不写更糟——Ctrl+Shift+P 就在这张表上挂了很久，
 * 用户按下去以为进了只读模式，实际权限一点没变。
 */
const ITEMS: Array<[string, string]> = [
  ["Ctrl/Cmd+K", "打开全局搜索"],
  ["Ctrl/Cmd+,", "打开设置"],
  ["Ctrl/Cmd+L", "清空消息"],
  ["Ctrl/Cmd+Shift+P", "在「只读调研」和「每次询问」之间切换"],
  ...(VOICE_UI_ENABLED
    ? ([["Ctrl/Cmd+Shift+F", "切换灵巧模式"]] as Array<[string, string]>)
    : []),
  ["Ctrl/Cmd+/", "打开本列表"],
  ["Enter", "发送"],
  ["Shift+Enter", "换行"],
  ["Escape", "关闭面板或中断生成"],
];

export function KeybindingsPanel({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-xl rounded-xl border border-border bg-surface-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-text-primary">快捷键</div>
          <button className="rounded px-2 py-1 text-xs text-text-subtle hover:bg-surface-hover" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="space-y-2">
          {ITEMS.map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <code className="text-xs text-cyan-300">{key}</code>
              <span className="text-xs text-text-muted">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
