/**
 * Build the hand-off prompt used by the AI expert onboarding flow.
 *
 * Keep the prompt here instead of burying it in the gallery click handler so
 * the fields introduced by the expert profile can be tested as one contract.
 * The model still has to show a confirmation card; this only makes the
 * proposal complete enough that the user does not have to rediscover every
 * field in the settings panel afterwards.
 */
export function buildAiExpertCreationDraft(description: string): string {
  return [
    "帮我创建一个数字专家。",
    "",
    "我的需求：",
    description.trim(),
    "",
    "请根据需求设计这个专家。信息不足时，只追问会明显影响专家效果的关键问题；信息已经足够时，不要重复询问。",
    "不要让我再次手填配置字段；请你先按安全默认值补全方案，确认卡里让我一次审阅。",
    "",
    "创建前，请整理并展示以下完整方案：",
    "- 名称",
    "- 个性签名（1 句话，作为专家资料页签名；不要把内部提示词当签名）",
    "- 角色定位",
    "- 简介",
    "- 专长标签（最多 8 个）",
    "- 工作方式与回答风格",
    "- 必要的行为边界",
    "- 默认运行权限（plan / ask / auto 三选一，并说明理由；不确定时使用 ask）",
    "- 初始核心资料：IDENTITY.md、SOUL.md、MEMORY.md。只写对该专家确实必要、且不含隐私/密钥的内容；没有稳定记忆时保持 MEMORY.md 的安全空模板。",
    "- 工作区策略：默认使用系统分配的专家专属隔离工作区。除非我明确选择并确认，不要要求、猜测或写入任何绝对路径。",
    "",
    "通过确认卡让我确认。只有确认后才能正式创建；如果我要求修改，请更新整套方案并再次确认。创建时把已确认的字段一次写入；如果某个字段没有专用写入口，也必须使用上述安全默认值，不要把配置工作退回给我。",
  ].join("\n");
}
