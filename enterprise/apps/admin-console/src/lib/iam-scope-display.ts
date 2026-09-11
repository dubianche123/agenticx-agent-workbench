import { expandRoleScopes, isRegisteredScope } from "@agenticx/iam-core";

export type ScopeDisplayOption = {
  value: string;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  group: string;
  groupEn: string;
};

type ScopeCopy = Omit<ScopeDisplayOption, "value">;

/**
 * Display metadata is deliberately separate from authorization.  The server
 * sends only scopes already granted to the actor; this map supplies labels for
 * those registered values and never manufactures a permission when the list
 * is empty.
 */
const SCOPE_DISPLAY: Record<string, ScopeCopy> = {
  "admin:enter": { label: "进入管理台", labelEn: "Enter admin console", description: "打开企业管理台", descriptionEn: "Open the enterprise admin console", group: "管理", groupEn: "Administration" },
  "user:read": { label: "查看成员", labelEn: "View members", description: "查看授权范围内的成员资料", descriptionEn: "View member profiles within the granted range", group: "成员", groupEn: "Members" },
  "user:create": { label: "创建成员", labelEn: "Create members", description: "在授权范围内创建成员", descriptionEn: "Create members within the granted range", group: "成员", groupEn: "Members" },
  "user:update": { label: "编辑成员资料", labelEn: "Edit member profiles", description: "更新授权范围内的成员资料", descriptionEn: "Update member profiles within the granted range", group: "成员", groupEn: "Members" },
  "user:delete": { label: "停用成员", labelEn: "Disable members", description: "停用授权范围内的成员", descriptionEn: "Disable members within the granted range", group: "成员", groupEn: "Members" },
  "user:manage": { label: "管理成员", labelEn: "Manage members", description: "执行成员管理操作", descriptionEn: "Manage member administration", group: "成员", groupEn: "Members" },
  "user:quota:update": { label: "修改成员额度", labelEn: "Update member quotas", description: "修改授权范围内的成员额度", descriptionEn: "Update quotas within the granted range", group: "成员", groupEn: "Members" },
  "user:models:update": { label: "修改成员模型", labelEn: "Update member models", description: "修改授权范围内的成员模型", descriptionEn: "Update models within the granted range", group: "成员", groupEn: "Members" },
  "dept:read": { label: "查看组织", labelEn: "View organization", description: "查看组织和部门目录", descriptionEn: "View the organization directory", group: "组织", groupEn: "Organization" },
  "dept:create": { label: "创建部门", labelEn: "Create departments", description: "创建部门目录节点", descriptionEn: "Create department directory nodes", group: "组织", groupEn: "Organization" },
  "dept:update": { label: "编辑部门", labelEn: "Edit departments", description: "编辑部门目录节点", descriptionEn: "Edit department directory nodes", group: "组织", groupEn: "Organization" },
  "dept:delete": { label: "删除部门", labelEn: "Delete departments", description: "删除部门目录节点", descriptionEn: "Delete department directory nodes", group: "组织", groupEn: "Organization" },
  "dept:manage": { label: "管理组织", labelEn: "Manage organization", description: "执行组织管理操作", descriptionEn: "Manage organization structure", group: "组织", groupEn: "Organization" },
  "role:read": { label: "查看权限角色", labelEn: "View permission roles", description: "查看角色目录和权限说明", descriptionEn: "View role catalog and permission descriptions", group: "权限", groupEn: "Permissions" },
  "role:create": { label: "创建权限角色", labelEn: "Create permission roles", description: "创建可授予的权限角色", descriptionEn: "Create grantable permission roles", group: "权限", groupEn: "Permissions" },
  "role:update": { label: "编辑权限角色", labelEn: "Edit permission roles", description: "编辑可授予的权限角色", descriptionEn: "Edit grantable permission roles", group: "权限", groupEn: "Permissions" },
  "role:delete": { label: "删除权限角色", labelEn: "Delete permission roles", description: "删除未被使用的自定义角色", descriptionEn: "Delete unused custom roles", group: "权限", groupEn: "Permissions" },
  "role:manage": { label: "管理权限角色", labelEn: "Manage permission roles", description: "管理权限角色配置", descriptionEn: "Manage permission role configuration", group: "权限", groupEn: "Permissions" },
  "role:assign": { label: "授予角色", labelEn: "Assign roles", description: "在可授予范围内绑定角色", descriptionEn: "Bind roles within the grantable range", group: "权限", groupEn: "Permissions" },
  "audit:read": { label: "查看审计", labelEn: "View audit", description: "查看授权范围内的审计记录", descriptionEn: "View audit records within the granted range", group: "审计", groupEn: "Audit" },
  "audit:read:all": { label: "查看企业审计", labelEn: "View enterprise audit", description: "查看当前企业的审计记录", descriptionEn: "View audit records for the current enterprise", group: "审计", groupEn: "Audit" },
  "audit:read:dept": { label: "查看部门审计", labelEn: "View department audit", description: "查看授权部门的审计记录", descriptionEn: "View audit records for granted departments", group: "审计", groupEn: "Audit" },
  "audit:export": { label: "导出审计", labelEn: "Export audit", description: "导出授权范围内的审计记录", descriptionEn: "Export audit records within the granted range", group: "审计", groupEn: "Audit" },
  "audit:manage": { label: "管理审计", labelEn: "Manage audit", description: "管理审计设置", descriptionEn: "Manage audit settings", group: "审计", groupEn: "Audit" },
  "metering:read": { label: "查看用量与额度", labelEn: "View usage and quotas", description: "查看授权范围内的用量与额度", descriptionEn: "View usage and quotas within the granted range", group: "用量", groupEn: "Usage" },
  "metering:export": { label: "导出用量", labelEn: "Export usage", description: "导出授权范围内的用量", descriptionEn: "Export usage within the granted range", group: "用量", groupEn: "Usage" },
  "metering:manage": { label: "管理用量", labelEn: "Manage usage", description: "管理用量与额度设置", descriptionEn: "Manage usage and quota settings", group: "用量", groupEn: "Usage" },
  "policy:read": { label: "查看策略", labelEn: "View policies", description: "查看企业策略", descriptionEn: "View enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:create": { label: "创建策略", labelEn: "Create policies", description: "创建企业策略", descriptionEn: "Create enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:update": { label: "编辑策略", labelEn: "Edit policies", description: "编辑企业策略", descriptionEn: "Edit enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:delete": { label: "删除策略", labelEn: "Delete policies", description: "删除企业策略", descriptionEn: "Delete enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:publish": { label: "发布策略", labelEn: "Publish policies", description: "发布企业策略", descriptionEn: "Publish enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:disable": { label: "停用策略", labelEn: "Disable policies", description: "停用企业策略", descriptionEn: "Disable enterprise policies", group: "策略", groupEn: "Policies" },
  "policy:manage": { label: "管理策略", labelEn: "Manage policies", description: "管理企业策略", descriptionEn: "Manage enterprise policies", group: "策略", groupEn: "Policies" },
  "kb:read": { label: "查看知识库", labelEn: "View knowledge bases", description: "查看知识库内容", descriptionEn: "View knowledge base content", group: "知识库", groupEn: "Knowledge" },
  "kb:create": { label: "创建知识库", labelEn: "Create knowledge bases", description: "创建知识库内容", descriptionEn: "Create knowledge base content", group: "知识库", groupEn: "Knowledge" },
  "kb:update": { label: "编辑知识库", labelEn: "Edit knowledge bases", description: "编辑知识库内容", descriptionEn: "Edit knowledge base content", group: "知识库", groupEn: "Knowledge" },
  "kb:delete": { label: "删除知识库", labelEn: "Delete knowledge bases", description: "删除知识库内容", descriptionEn: "Delete knowledge base content", group: "知识库", groupEn: "Knowledge" },
  "kb:manage": { label: "管理知识库", labelEn: "Manage knowledge bases", description: "管理知识库设置", descriptionEn: "Manage knowledge base settings", group: "知识库", groupEn: "Knowledge" },
  "automation:read": { label: "查看自动化", labelEn: "View automations", description: "查看自动化任务", descriptionEn: "View automation tasks", group: "自动化", groupEn: "Automation" },
  "automation:create": { label: "创建自动化", labelEn: "Create automations", description: "创建自动化任务", descriptionEn: "Create automation tasks", group: "自动化", groupEn: "Automation" },
  "automation:update": { label: "编辑自动化", labelEn: "Edit automations", description: "编辑自动化任务", descriptionEn: "Edit automation tasks", group: "自动化", groupEn: "Automation" },
  "automation:delete": { label: "删除自动化", labelEn: "Delete automations", description: "删除自动化任务", descriptionEn: "Delete automation tasks", group: "自动化", groupEn: "Automation" },
  "automation:manage": { label: "管理自动化", labelEn: "Manage automations", description: "管理自动化任务", descriptionEn: "Manage automation tasks", group: "自动化", groupEn: "Automation" },
  "sso:read": { label: "查看单点登录", labelEn: "View SSO", description: "查看单点登录配置", descriptionEn: "View single sign-on configuration", group: "单点登录", groupEn: "Single sign-on" },
  "sso:create": { label: "创建单点登录", labelEn: "Create SSO", description: "创建单点登录配置", descriptionEn: "Create single sign-on configuration", group: "单点登录", groupEn: "Single sign-on" },
  "sso:update": { label: "编辑单点登录", labelEn: "Edit SSO", description: "编辑单点登录配置", descriptionEn: "Edit single sign-on configuration", group: "单点登录", groupEn: "Single sign-on" },
  "sso:delete": { label: "删除单点登录", labelEn: "Delete SSO", description: "删除单点登录配置", descriptionEn: "Delete single sign-on configuration", group: "单点登录", groupEn: "Single sign-on" },
  "sso:manage": { label: "管理单点登录", labelEn: "Manage SSO", description: "管理单点登录配置", descriptionEn: "Manage single sign-on configuration", group: "单点登录", groupEn: "Single sign-on" },
  "model:read": { label: "查看模型", labelEn: "View models", description: "查看模型目录", descriptionEn: "View the model catalog", group: "模型", groupEn: "Models" },
  "model:create": { label: "创建模型", labelEn: "Create models", description: "创建模型服务配置", descriptionEn: "Create model service configurations", group: "模型", groupEn: "Models" },
  "model:update": { label: "编辑模型", labelEn: "Edit models", description: "编辑模型服务配置", descriptionEn: "Edit model service configurations", group: "模型", groupEn: "Models" },
  "model:delete": { label: "删除模型", labelEn: "Delete models", description: "删除模型服务配置", descriptionEn: "Delete model service configurations", group: "模型", groupEn: "Models" },
  "model:manage": { label: "管理模型", labelEn: "Manage models", description: "管理模型服务", descriptionEn: "Manage model services", group: "模型", groupEn: "Models" },
  "provider:read": { label: "查看模型服务", labelEn: "View providers", description: "查看模型服务配置", descriptionEn: "View provider configurations", group: "模型服务", groupEn: "Providers" },
  "provider:create": { label: "创建模型服务", labelEn: "Create providers", description: "创建模型服务配置", descriptionEn: "Create provider configurations", group: "模型服务", groupEn: "Providers" },
  "provider:update": { label: "配置模型服务", labelEn: "Configure providers", description: "编辑模型服务配置", descriptionEn: "Edit provider configurations", group: "模型服务", groupEn: "Providers" },
  "provider:delete": { label: "删除模型服务", labelEn: "Delete providers", description: "删除模型服务配置", descriptionEn: "Delete provider configurations", group: "模型服务", groupEn: "Providers" },
  "provider:manage": { label: "管理模型服务", labelEn: "Manage providers", description: "管理模型服务", descriptionEn: "Manage provider services", group: "模型服务", groupEn: "Providers" },
  "gateway:read": { label: "查看网关状态", labelEn: "View gateway health", description: "查看企业网关健康状态", descriptionEn: "View enterprise gateway health", group: "网关", groupEn: "Gateway" },
  "gateway:manage": { label: "管理网关", labelEn: "Manage gateway", description: "管理企业网关配置", descriptionEn: "Manage enterprise gateway configuration", group: "网关", groupEn: "Gateway" },
  "assistant:use": { label: "使用个人助手", labelEn: "Use personal assistant", description: "在当前授权范围内使用个人助手", descriptionEn: "Use the personal assistant within the granted range", group: "助手", groupEn: "Assistant" },
  "agent:read": { label: "查看企业 Agent", labelEn: "View enterprise agents", description: "查看授权范围内的企业 Agent", descriptionEn: "View enterprise agents within the granted range", group: "企业 Agent", groupEn: "Enterprise agents" },
  "agent:create": { label: "创建企业 Agent", labelEn: "Create enterprise agents", description: "注册企业 Agent", descriptionEn: "Register enterprise agents", group: "企业 Agent", groupEn: "Enterprise agents" },
  "agent:update": { label: "编辑企业 Agent", labelEn: "Edit enterprise agents", description: "编辑企业 Agent 配置", descriptionEn: "Edit enterprise agent configuration", group: "企业 Agent", groupEn: "Enterprise agents" },
  "agent:delete": { label: "删除企业 Agent", labelEn: "Delete enterprise agents", description: "删除企业 Agent", descriptionEn: "Delete enterprise agents", group: "企业 Agent", groupEn: "Enterprise agents" },
  "agent:manage": { label: "管理企业 Agent", labelEn: "Manage enterprise agents", description: "管理企业 Agent 生命周期", descriptionEn: "Manage enterprise agent lifecycle", group: "企业 Agent", groupEn: "Enterprise agents" },
  "workspace:read": { label: "查看工作区", labelEn: "View workspaces", description: "查看授权工作区", descriptionEn: "View granted workspaces", group: "工作区", groupEn: "Workspaces" },
  "workspace:chat": { label: "使用工作区对话", labelEn: "Use workspace chat", description: "使用工作区对话功能", descriptionEn: "Use workspace chat", group: "工作区", groupEn: "Workspaces" },
  "workspace:manage": { label: "管理工作区", labelEn: "Manage workspaces", description: "管理工作区设置", descriptionEn: "Manage workspace settings", group: "工作区", groupEn: "Workspaces" },
};

export function scopeDisplayOptions(scopes: readonly string[]): ScopeDisplayOption[] {
  return expandRoleScopes([...new Set(scopes)])
    .filter((scope) => isRegisteredScope(scope))
    .map((scope) => ({
      value: scope,
      ...(SCOPE_DISPLAY[scope] ?? {
        label: scope,
        labelEn: scope,
        description: scope,
        descriptionEn: scope,
        group: "其他",
        groupEn: "Other",
      }),
    }));
}
