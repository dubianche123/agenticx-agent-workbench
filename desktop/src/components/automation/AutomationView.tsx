import { MainViewShell } from "../ds/MainViewShell";
import { AutomationTab } from "./AutomationTab";

/** Main-area view for scheduled tasks — reuses the settings AutomationTab. */
export function AutomationView() {
  return (
    <MainViewShell>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-text-strong">定时任务</h2>
        <p className="mt-1 text-sm text-text-muted">关闭窗口后仍在后台执行；退出应用后停止。</p>
      </div>
      <AutomationTab showIntro={false} />
    </MainViewShell>
  );
}
