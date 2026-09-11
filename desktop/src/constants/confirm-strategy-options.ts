/**
 * 权限词汇表。**一个字段,一个真相。**
 *
 * 上一版把「运行模式」拆成两处持久化:桌面端配置的 confirmStrategy 和后端的
 * permissions.mode。两处写入就有写成一半的可能,于是又造了一套分布式回滚去补救——
 * 补救逻辑本身还有「请求失败不等于没写入」的窟窿。这是在给一个不该存在的问题
 * 加复杂度。
 *
 * 现在设置页只持久化 ``permissions.mode`` 这个全局默认；每个会话的实际模式保存于
 * session 元数据。没有两处写入、没有回滚、没有对账；写失败就重新拉一次后端的真实
 * 值显示出来。
 */

/** 用户看到的三个运行模式；设置页改默认值，对话页改当前 session。 */
export type RunMode = "plan" | "ask" | "auto";

export type RunModeOption = {
  value: RunMode;
  label: string;
  /** 一句话讲清「什么会发生」,不讲实现。 */
  description: string;
};

/**
 * 文案对着真实机制写。
 *
 * 「代我批准」这一档的措辞前后错了两次,方向相反,两次都是同一个毛病:照着名字想当然,
 * 没去读 ``RiskAwareAutoConfirmGate``。
 *
 * 第一次写「低风险操作由我代你批准」——听上去像有个 low/high 的标签在决定。
 * 第二次改成「沙箱兜不住的操作由我代你批准」,**把承诺放大到了机制的反面**:沙箱兜得
 * 住的那些根本不产生确认请求(`ls && pwd` 不弹框),压根轮不到这一档管;真正交上来的
 * 就是沙箱兜不住的,而这一档对它们几乎一律照问不误。
 *
 * 实际做的事只有一件:``risk: "low"`` 的确认请求直接放行——目前就是工作区内的文件
 * 写入与编辑(file_write / file_edit / codegen)。其余全部仍然会问,包括
 * ``non_whitelisted``,也就是**任何一条解析不出来的命令**。
 *
 * 这个方向的错更贵:承诺得越宽,用户越会以为自己开的是「全自动」,于是把弹出来的框
 * 当噪音随手点掉。宁可写窄一点。
 */
export const RUN_MODE_OPTIONS: readonly RunModeOption[] = [
  {
    value: "plan",
    label: "只读调研",
    description: "只查看和分析，不修改任何文件。",
  },
  {
    value: "ask",
    label: "每次询问",
    description: "沙箱兜不住的操作，每次都问你。",
  },
  {
    value: "auto",
    label: "代我批准",
    description: "自动批准工作区内的低风险修改；高风险操作仍然会问。",
  },
] as const;

export function runModeLabel(mode: RunMode): string {
  return RUN_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? RUN_MODE_OPTIONS[1].label;
}

/**
 * 读后端返回值时的归一化。
 *
 * 不做旧取值兼容——``default`` / ``semi-auto`` / ``full_auto`` 在后端已经整个删掉，
 * 到这里也只是「认不出来」的一种。

 * 认不出来的一律落到 ``"ask"``——**往严的方向兜底**。落到 auto 会让人在不知情的
 * 情况下少收到确认，而他没有任何迹象可以发现。
 */
export function normalizeRunMode(raw: unknown): RunMode {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "plan") return "plan";
  if (text === "auto") return "auto";
  return "ask";
}

/**
 * 单个确认框里的选择:这次许可管多久。
 *
 * 旧的 `run-everything`(「以后代我批准」)删了——它做的是从对话框里改全局模式,
 * 一个「批准这次操作」的按钮顺手把整个会话的策略改掉,是意料之外的副作用。
 * 换成 `always`:只对**这一条命令**在**这个工作区**里持久生效,写进
 * `permissions.allowed_commands`,设置页能看见也能撤销。
 */
export type ConfirmPolicy = "once" | "this-run" | "always";

export type ConfirmPolicyOption = {
  value: ConfirmPolicy;
  label: string;
  description: string;
};

export const CONFIRM_POLICY_OPTIONS: readonly ConfirmPolicyOption[] = [
  {
    value: "once",
    label: "仅这一次",
    description: "只执行上方这次操作；下次遇到需要授权的操作仍会询问。",
  },
  {
    value: "this-run",
    label: "本次任务内不再问",
    description: "当前任务结束前，与本次类型和范围相同的操作自动允许；任务结束即失效。",
  },
  {
    value: "always",
    label: "以后都不再问这条命令",
    description: "写入设置，长期生效。只对完全相同的命令、且只在当前工作区内有效，可随时在设置里撤销。",
  },
] as const;

export function confirmPolicyLabel(policy: ConfirmPolicy): string {
  return (
    CONFIRM_POLICY_OPTIONS.find((option) => option.value === policy)?.label ??
    CONFIRM_POLICY_OPTIONS[0].label
  );
}

/**
 * 框弹出来时预选哪一个。
 *
 * 一律是「仅这一次」。预选一个更宽松的选项等于替用户先按了一半——他要做的判断
 * 本来就是「这次要不要放」,不该被默认值推着走。
 */
export const DEFAULT_CONFIRM_POLICY: ConfirmPolicy = "once";
