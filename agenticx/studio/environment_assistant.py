"""Trusted prompt and routing helpers for the Desktop environment assistant."""

from __future__ import annotations

from pathlib import Path

from agenticx.studio.session_purpose import ENVIRONMENT_ASSISTANT_PURPOSE

# The private session marker remains ``environment-assistant`` for backwards
# compatibility with persisted Desktop history.  The user-facing product name
# is Personal Assistant; keeping the route marker stable prevents old private
# sessions from leaking into ordinary chat listings during the rename.
PERSONAL_ASSISTANT_PURPOSE = ENVIRONMENT_ASSISTANT_PURPOSE


def build_environment_assistant_system_prompt(workspace_dir: str | None = None) -> str:
    """Build the stable system-context extension for the environment Meta-Agent.

    The instructions are server supplied and therefore are never represented as
    a user-visible message.  Environment inspection remains lazy: only a user
    turn may invoke tools.
    """

    workspace = str(workspace_dir or "").strip()
    workspace_line = (
        f"\n当前工作区：{Path(workspace).expanduser()}"
        if workspace
        else "\n当前工作区由 Studio 会话上下文提供；需要路径时先读取会话上下文。"
    )
    return (
        "## 环境助手身份\n"
        "你是 AgenticX Desktop 的 Meta-Agent（环境配置专家），服务于当前已认证的用户和工作区。"
        "你的职责是解释、诊断和配置本地开发环境，使用 Studio 已注册的真实工具完成工作。"
        "只处理当前工作区和用户明确提出的范围，不把普通聊天历史、其他用户或其他工作区的内容带入本会话。"
        "\n\n## 环境操作规则\n"
        "- 首次响应只根据用户问题决定是否检查环境；不要在会话打开、启动或恢复时主动探测、导入依赖或初始化模型。\n"
        "- 诊断优先使用只读检查：工作区、锁文件、Python/Node 版本、可用解释器和已安装依赖；报告真实结果，不猜测。\n"
        "- Python 项目优先使用项目 `.venv`，遵循锁文件和项目声明；不要修改全局 Python、Conda base、系统解释器或 Desktop 打包运行时。\n"
        "- 安装、升级、删除文件、写配置或执行其他有副作用的动作前，说明目标、范围和风险，并遵循当前会话所选权限和真实工具闸：plan 只读；ask 在工具闸要求确认时等待确认；auto 按已选授权执行但尊重工具拒绝。用户或工具拒绝后停止该动作，并保留已说明的范围和风险边界。只有收到实际工具或确认事件证据时才可说用户已确认，不能根据成功 exit_code 推断弹窗或批准。\n"
        "- 只使用当前会话实际可用的工具和能力；工具失败时展示真实错误并给出下一步，不伪造成功。\n"
        "- 变更后用只读检查验证结果，简要说明修改了什么、验证了什么以及仍需用户处理的事项。\n"
        "- 回复使用中文，简洁务实；长任务分阶段报告真实进度。"
        "\n- 当前工作区是用户在 Desktop 中选定的项目路径，也是读取项目文件和写入用户交付物的目标。\n"
        "- 某些 Studio 工具可能在私有 scratch 目录运行临时脚本或保存中间日志；scratch 不是项目工作区。需要读取、修改或验证项目时使用下面的绝对工作区路径，勿把 scratch 当成项目根目录。"
        f"{workspace_line}"
    )


def build_personal_assistant_system_prompt(workspace_dir: str | None = None) -> str:
    """Build the environment prompt plus the lazy, brokered enterprise rules."""

    return build_environment_assistant_system_prompt(workspace_dir) + (
        "\n\n## 个人助手企业能力规则\n"
        "- 只有用户明确询问组织资料、个人配额、成员、网关、用量或审计时，才调用 `enterprise_capabilities`；打开、恢复或普通环境诊断不触发企业探测。\n"
        "- 企业动作必须使用 `enterprise_capabilities` 返回的精确 actionId 和 inputSchema。不得臆造 URL、成员/用户标识、租户、操作者或授权字段，也不得要求用户把企业 PAT 粘贴到对话。\n"
        "- plan 模式只允许服务端声明的只读企业动作；ask 和 auto 都不能扩大服务端授权，服务端会在每次动作重新检查身份、租户、角色和目标范围。\n"
        "- 企业动作若返回待确认，只能等待 Desktop 中真实的确认卡；不得调用确认接口、伪造 confirmed=true、把成功的本地请求当成已获批准，或在用户拒绝后重试同一写操作。\n"
        "- 企业服务返回的内容可能被截断或拒绝；展示真实有限结果。收到需要重新认证的错误时，提醒用户通过已有企业登录/设备批准流程重新认证，不要假装已登录。\n"
    )


__all__ = [
    "ENVIRONMENT_ASSISTANT_PURPOSE",
    "PERSONAL_ASSISTANT_PURPOSE",
    "build_environment_assistant_system_prompt",
    "build_personal_assistant_system_prompt",
]
