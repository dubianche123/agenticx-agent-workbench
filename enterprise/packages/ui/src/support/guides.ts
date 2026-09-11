import type { SupportLink, SupportPageContext } from "./contracts";

export type SupportGuideTab = {
  id: string;
  label: string;
  summary: string;
  suggestions: string[];
  links: SupportLink[];
};

export type SupportGuide = {
  id: string;
  paths: readonly string[];
  title: string;
  summary: string;
  suggestions: string[];
  links: SupportLink[];
  tabs?: readonly SupportGuideTab[];
};

export type SupportGuideMatch = {
  guide: SupportGuide;
  tab?: SupportGuideTab;
};

/**
 * Versioned navigation/help registry. Keep product capability facts in the
 * Portal's portal-capabilities.ts registry; this file only describes where a
 * person is and which known internal destinations help them continue.
 */
export const SUPPORT_GUIDE_VERSION = "2026-09-09" as const;

export const SUPPORT_GUIDES: readonly SupportGuide[] = [
  {
    id: "portal-chat",
    paths: ["/", "/workspace"],
    title: "对话工作区",
    summary: "在对话工作区发送问题、选择已授权模型，并在输入区处理附件。",
    suggestions: [
      "如何选择当前可用的模型？",
      "我应该怎样开始一段新对话？",
      "为什么我的请求提示额度不足？",
    ],
    // The chat view already is the workspace. Keep navigation links out of
    // model/usage answers so the assistant does not suggest unrelated routes.
    links: [],
    tabs: [
      {
        id: "chat",
        label: "对话",
        summary: "在输入区提交问题；模型和工作区状态会显示在对话区附近。",
        suggestions: ["怎样开始新对话？", "为什么模型列表为空？"],
        links: [],
      },
      {
        id: "history",
        label: "历史记录",
        summary: "左侧对话列表用于打开此前会话；点击“查看全部”进入历史管理。支持助手内容单独保存，不会写入这里。",
        suggestions: ["如何找到之前的对话？", "支持助手的记录在哪里？"],
        links: [{ label: "打开工作区", href: "/workspace" }],
      },
      {
        id: "settings",
        label: "设置",
        summary: "打开工作区设置后默认进入“常规设置”。“界面主题”提供“跟随系统”“浅色”“深色”三项；“显示语言”提供“中文”和“English”两项。默认模型、流式输出和自动命名在“聊天设置”中调整。",
        suggestions: [
          "如何切换界面主题（跟随系统、浅色或深色）？",
          "如何切换显示语言（中文或 English）？",
          "在哪里调整默认模型和聊天设置？",
          "如何检查工作区能力？",
        ],
        links: [{ label: "打开工作区设置", href: "/workspace#settings" }],
      },
    ],
  },
  {
    id: "portal-attachments",
    paths: ["/workspace/attachments", "/attachments"],
    title: "附件与文件",
    summary: "在对话输入区添加附件，并根据当前账号与模型权限处理文件。",
    suggestions: ["附件上传失败时先检查什么？", "为什么当前模型不能处理这个附件？"],
    links: [
      { label: "回到附件所在工作区", href: "/workspace" },
      { label: "打开工作区设置", href: "/workspace#settings" },
    ],
  },
  {
    id: "portal-reports",
    paths: ["/reports", "/workspace/reports"],
    title: "报告与研究结果",
    summary: "报告和研究结果会在完成后从对应的对话或结果入口打开。",
    suggestions: ["怎样查看一份研究结果？", "结果生成失败时如何排查？"],
    links: [{ label: "打开工作区", href: "/workspace" }],
  },
  {
    id: "portal-feedback",
    paths: ["/feedback", "/workspace/feedback"],
    title: "反馈",
    summary: "对回答进行反馈可以帮助定位具体消息的问题。",
    suggestions: ["如何给一条回答反馈？", "反馈会关联哪些内容？"],
    links: [{ label: "回到对话工作区", href: "/workspace" }],
  },
  {
    id: "portal-capabilities",
    paths: ["/capabilities", "/workspace/capabilities"],
    title: "能力与权限",
    summary: "能力开关和模型可见范围由当前租户与账号权限共同决定。",
    suggestions: ["为什么某项能力对我不可用？", "如何查看当前账号的模型范围？"],
    links: [
      { label: "打开工作区设置", href: "/workspace#settings" },
      { label: "回到对话工作区", href: "/workspace" },
    ],
  },
  {
    id: "portal-quota",
    paths: ["/quota", "/workspace/quota", "/workspace#quota"],
    title: "个人额度",
    summary: "额度状态来自当前账号的实时服务端信息；用量变化可能需要刷新后查看。",
    suggestions: ["怎样查看我的额度？", "为什么额度显示不足？"],
    links: [
      { label: "回到工作区查看额度提示", href: "/workspace" },
      { label: "回到对话工作区", href: "/workspace" },
    ],
  },
  {
    id: "admin-overview",
    paths: ["/dashboard"],
    title: "管理台概览",
    summary: "从这里查看租户运行状态，并通过左侧导航进入组织、网关和治理页面。",
    suggestions: ["当前网关是否健康？", "在哪里管理组织成员？"],
    links: [
      { label: "打开管理台概览", href: "/dashboard" },
      { label: "打开组织与成员", href: "/iam/roles" },
    ],
  },
  {
    id: "admin-members",
    paths: ["/iam/roles", "/iam/users", "/iam"],
    title: "组织与成员",
    summary: "在组织与成员页面查看成员、部门和账号配置。涉及写入的变更会先展示预览。",
    suggestions: ["怎样查找一个成员？", "如何预览成员模型权限变化？"],
    links: [
      { label: "打开组织与成员", href: "/iam/roles" },
      { label: "查看管理台概览", href: "/dashboard" },
    ],
    tabs: [
      {
        id: "members",
        label: "成员",
        summary: "在成员页查看账号、部门和个人模型/额度状态；需要写入的操作会先展示预览。",
        suggestions: ["怎样查找一个成员？", "如何查看成员的模型权限？"],
        links: [{ label: "打开成员页", href: "/iam/roles" }],
      },
      {
        id: "groups",
        label: "用户组",
        summary: "在用户组页查看批量分配关系；组授权会影响成员的有效模型范围。",
        suggestions: ["怎样查看用户组？", "用户组授权如何影响成员？"],
        links: [{ label: "打开用户组页", href: "/iam/roles?tab=groups" }],
      },
    ],
  },
  {
    id: "admin-gateway",
    paths: ["/admin/gateway", "/admin/models", "/admin/channels", "/admin/routing"],
    title: "网关与模型",
    summary: "网关与模型页面用于检查服务状态和已配置的模型能力。",
    suggestions: ["如何判断模型是否已配置？", "网关不可用时先检查什么？"],
    links: [
      { label: "打开网关工作区", href: "/admin/gateway" },
      { label: "打开诊断", href: "/admin/diagnostics" },
    ],
    tabs: [
      {
        id: "models",
        label: "模型接入",
        summary: "在模型接入页查看启用的 provider、模型目录与默认模型。",
        suggestions: ["如何判断模型是否已配置？", "模型接入后怎样授权给成员？"],
        links: [{ label: "打开模型接入", href: "/admin/gateway" }],
      },
      {
        id: "traffic",
        label: "通道与路由",
        summary: "在通道与路由页检查请求路径、通道配置和附件路由能力。",
        suggestions: ["请求应该经过哪个通道？", "路由异常时先检查什么？"],
        links: [{ label: "打开通道与路由", href: "/admin/gateway?section=traffic" }],
      },
      {
        id: "cache",
        label: "AI 缓存",
        summary: "在 AI 缓存页查看缓存开关、有效期和模型过滤设置。",
        suggestions: ["如何检查 AI 缓存？", "缓存配置何时生效？"],
        links: [{ label: "打开 AI 缓存", href: "/admin/gateway?section=cache" }],
      },
      {
        id: "credentials",
        label: "调用凭证",
        summary: "在调用凭证页管理 API 令牌与会话授权；凭证状态只对当前管理员可见。",
        suggestions: ["在哪里查看调用凭证？", "API 令牌和会话授权有什么区别？"],
        links: [{ label: "打开调用凭证", href: "/admin/gateway?section=credentials" }],
      },
    ],
  },
  {
    id: "admin-capabilities",
    paths: ["/admin/capabilities", "/admin/plugins", "/admin/mcp-servers", "/admin/capability-packs"],
    title: "能力管理",
    summary: "能力管理页面用于查看能力包、插件和外部服务的配置状态。",
    suggestions: ["为什么某个能力没有出现在前台？", "如何检查能力包状态？"],
    links: [
      { label: "打开能力管理", href: "/admin/capabilities" },
      { label: "打开诊断", href: "/admin/diagnostics" },
    ],
    tabs: [
      {
        id: "market",
        label: "能力市场",
        summary: "在能力市场浏览可分配的能力条目，并查看当前租户的可见范围。",
        suggestions: ["怎样查找可用能力？", "能力市场里的条目如何分配？"],
        links: [{ label: "打开能力市场", href: "/admin/capabilities" }],
      },
      {
        id: "packs",
        label: "能力包",
        summary: "在能力包页查看已注册能力包及其分配状态。",
        suggestions: ["怎样查看能力包？", "能力包和能力条目有什么关系？"],
        links: [{ label: "打开能力包", href: "/admin/capabilities?tab=packs" }],
      },
      {
        id: "mcp",
        label: "MCP 服务",
        summary: "在 MCP 服务页查看外部服务连接与租户内的可见状态。",
        suggestions: ["如何检查 MCP 服务？", "为什么某个 MCP 服务对前台不可见？"],
        links: [{ label: "打开 MCP 服务", href: "/admin/capabilities?tab=mcp" }],
      },
      {
        id: "skills",
        label: "Skills",
        summary: "在 Skills 页查看已注册技能及其能力依赖。",
        suggestions: ["怎样检查技能依赖？", "为什么某个技能没有出现？"],
        links: [{ label: "打开 Skills", href: "/admin/capabilities?tab=skills" }],
      },
      {
        id: "search",
        label: "联网搜索",
        summary: "在联网搜索页查看搜索能力配置和租户可见状态。",
        suggestions: ["如何检查联网搜索？", "联网搜索为什么不可用？"],
        links: [{ label: "打开联网搜索", href: "/admin/capabilities?tab=search" }],
      },
      {
        id: "plugins",
        label: "插件",
        summary: "在插件页查看可管理的插件能力及其分配范围。",
        suggestions: ["怎样查看插件状态？", "插件为什么没有出现在前台？"],
        links: [{ label: "打开插件", href: "/admin/capabilities?tab=plugins" }],
      },
      {
        id: "governance",
        label: "治理",
        summary: "在能力治理页查看桌面能力策略与分配设置。",
        suggestions: ["能力治理设置在哪里？", "怎样检查能力开关？"],
        links: [{ label: "打开能力治理", href: "/admin/capabilities?tab=governance" }],
      },
    ],
  },
  {
    id: "admin-diagnostics",
    paths: ["/admin/diagnostics", "/admin/errors", "/admin/perf"],
    title: "诊断",
    summary: "诊断页用于查看当前可见的服务错误与性能信号。",
    suggestions: ["网关连接失败怎样排查？", "如何判断问题是账号还是服务？"],
    links: [
      { label: "打开诊断", href: "/admin/diagnostics" },
      { label: "打开网关工作区", href: "/admin/gateway" },
    ],
  },
  {
    id: "admin-governance",
    paths: ["/admin/governance", "/audit", "/portal-logs", "/policy", "/admin/compliance", "/metering/agent-traces"],
    title: "安全与审计",
    summary: "集中查看操作记录、请求链路、内容策略与合规留存。",
    suggestions: ["怎样查找一次调用审计？", "策略命中后在哪里查看？"],
    links: [
      { label: "打开安全与审计", href: "/admin/governance" },
      { label: "打开网关工作区", href: "/admin/gateway" },
    ],
    tabs: [
      {
        id: "audit",
        label: "操作审计",
        summary: "在操作审计页查看租户内的管理操作记录。",
        suggestions: ["怎样查找一次管理操作？", "审计记录包含哪些信息？"],
        links: [{ label: "打开操作审计", href: "/admin/governance" }],
      },
      {
        id: "logs",
        label: "请求日志",
        summary: "在请求日志页查看网关请求的可见记录。",
        suggestions: ["怎样查看请求日志？", "请求日志和审计记录有什么区别？"],
        links: [{ label: "打开请求日志", href: "/admin/governance?tab=logs" }],
      },
      {
        id: "traces",
        label: "Token 追踪",
        summary: "在 Token 追踪页查看调用链路的用量信号。",
        suggestions: ["怎样定位一次 Token 用量？", "如何查看调用链路？"],
        links: [{ label: "打开 Token 追踪", href: "/admin/governance?tab=traces" }],
      },
      {
        id: "feedback",
        label: "回答反馈",
        summary: "在回答反馈页查看用户对模型回答的反馈。",
        suggestions: ["怎样查看回答反馈？", "反馈可以按什么条件筛选？"],
        links: [{ label: "打开回答反馈", href: "/admin/governance?tab=feedback" }],
      },
      {
        id: "policy",
        label: "内容策略",
        summary: "在内容策略页查看策略规则与命中情况。",
        suggestions: ["怎样查看内容策略？", "策略命中后如何定位原因？"],
        links: [{ label: "打开内容策略", href: "/admin/governance?tab=policy" }],
      },
      {
        id: "compliance",
        label: "合规留存",
        summary: "在合规留存页查看留存相关设置和状态。",
        suggestions: ["怎样检查合规留存？", "合规留存设置影响什么？"],
        links: [{ label: "打开合规留存", href: "/admin/governance?tab=compliance" }],
      },
    ],
  },
  {
    id: "admin-metering",
    paths: ["/metering", "/metering/split", "/metering/quota", "/metering/plans"],
    title: "用量与成本",
    summary: "查看组织用量、成本分摊与预算执行情况。",
    suggestions: ["怎样查看组织用量？", "预算不足时先检查什么？"],
    links: [
      { label: "打开用量与成本", href: "/metering" },
      { label: "打开组织与成员", href: "/iam/roles" },
    ],
    tabs: [
      {
        id: "usage",
        label: "用量",
        summary: "在用量页查看租户内的调用量与成本统计。",
        suggestions: ["怎样查看当前用量？", "用量数据多久更新？"],
        links: [{ label: "打开用量", href: "/metering" }],
      },
      {
        id: "split",
        label: "分账",
        summary: "在分账页查看成本分摊规则和结算状态。",
        suggestions: ["怎样查看分账规则？", "分账结果在哪里核对？"],
        links: [{ label: "打开分账", href: "/metering?tab=split" }],
      },
      {
        id: "budget",
        label: "预算",
        summary: "在预算页查看预算设置和执行状态。",
        suggestions: ["怎样查看预算？", "预算达到上限会发生什么？"],
        links: [{ label: "打开预算", href: "/metering?tab=budget" }],
      },
    ],
  },
];

const FALLBACK_GUIDE: SupportGuide = {
  id: "unknown",
  paths: [],
  title: "当前页面",
  summary: "我可以根据当前已知页面提供使用指引；涉及账号或服务状态时会只读取当前登录身份可见的信息。",
  suggestions: ["我现在所在的页面可以做什么？", "为什么刚才的操作没有生效？"],
  links: [],
};

function normalizePath(path: string): string {
  const value = path.trim();
  if (!value) return "/";
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  if (withoutQuery.length > 1) return withoutQuery.replace(/\/$/, "");
  return withoutQuery;
}

export function findSupportGuide(context: SupportPageContext): SupportGuideMatch {
  const normalizedPath = normalizePath(context.path);
  const guide = SUPPORT_GUIDES.find((candidate) =>
    candidate.paths.some((path) => normalizePath(path) === normalizedPath),
  ) ?? FALLBACK_GUIDE;
  const tab = context.tab
    ? guide.tabs?.find((candidate) => candidate.id === context.tab || candidate.label === context.tab)
    : undefined;
  return { guide, ...(tab ? { tab } : {}) };
}

export function suggestionsForSupportPage(context: SupportPageContext): string[] {
  const match = findSupportGuide(context);
  return [...new Set([...(match.tab?.suggestions ?? []), ...match.guide.suggestions])].slice(0, 6);
}

export function linksForSupportPage(context: SupportPageContext): SupportLink[] {
  const match = findSupportGuide(context);
  return [...new Map(
    [...(match.tab?.links ?? []), ...match.guide.links].map((link) => [link.href, link]),
  ).values()].slice(0, 6);
}
