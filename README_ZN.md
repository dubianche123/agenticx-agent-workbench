# AgenticX Workbench · 智能体工作台

[English](README.md) · **简体中文**

<div align="center">
  <img src="assets/agenticx-logo.svg" alt="AgenticX Workbench" width="420" />
  <p><strong>把 Python 智能体运行时、本机优先桌面工作台与企业控制面放在同一套代码树里。</strong></p>

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
  [![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB.svg)](https://www.python.org/)
  [![Desktop](https://img.shields.io/badge/Desktop-Electron-47848F.svg)](desktop/)
  [![Enterprise](https://img.shields.io/badge/Enterprise-Portal%20%2B%20Gateway-0F766E.svg)](enterprise/)
</div>

做智能体产品时，往往要同时面对三层需求：底层需要一个能跑 ReAct 循环、调工具、解析文档的 Python 运行时；个人日常使用需要一个带本地工作区和终端的桌面客户端；到了团队落地阶段，又需要一套管身份、配额、模型路由和审计日志的网关与后台。

**AgenticX Workbench** 基于 Ziran Li 与贡献者开发的 [AgenticX](https://github.com/DemonDamon/AgenticX)（保留上游 Apache-2.0 许可与作者署名），把这三种形态整合在同一个预览发行版仓库里：

- **想在自己的服务或脚本里写 Agent**：直接从 [Python 快速开始](#快速开始)（`agenticx/`）入手。
- **想体验本机优先的多智能体桌面工作台**：查看 [Ontology Desktop 指南](desktop/README.md)（`desktop/`）。
- **想了解企业门户、Go AI 网关、配额与审计链路**：查看 [AgenticX Enterprise 指南](enterprise/README.md)（`enterprise/`）。

> **当前状态：** Python SDK 与核心运行时是最稳定的入口；桌面端（Ontology Desktop）与企业端（Enterprise）处于持续演进的预览阶段，打包方式、连接器执行器与工作流画布仍在快速迭代中。

## 仓库包含什么

| 目录 | 用途 |
| --- | --- |
| agenticx/ | Python SDK、Agent Runtime、Studio 服务、CLI、工具、记忆、知识库、协议与安全组件 |
| desktop/ | Electron + React 本机优先桌面应用 |
| enterprise/ | Web Portal、Admin Console、Go AI Gateway、IAM/RBAC、策略、计量、审计与部署文件 |
| examples/ | Agent、工具、检索、文档和集成示例 |
| docs/ | 概念、安装、CLI、API、安全和运维文档 |
| packaging/ | 自包含桌面后端与安装包脚本 |

三种产品形态共享 Agent 和工具抽象，但部署链路彼此独立：

- **Python Runtime**：将 AgenticX 嵌入自己的服务或脚本。
- **Ontology Desktop**：本机优先的对话与多智能体工作台，支持工作区、文件和文档产物、MCP、Skills，以及可选的企业连接。
- **AgenticX Enterprise**：企业统一入口和控制面，包含 Portal、管理后台、网关、身份、角色、配额、策略和审计。

## 核心能力

- **Agent 与 ReAct 执行**：类型化的 Agent、Task、Tool、ReAct 原语，支持事件流、多轮历史、并行工具调用、重试和上下文卸载。
- **多智能体协作**：Meta-Agent 路由、委派 Worker、分身和群聊抽象、并发限制与会话隔离。
- **工作流基础设施**：图与 Flow 编排、条件路由、并行分支、运行轨迹和人工审批钩子。
- **工具与连接器**：函数工具、MCP Hub、OpenAPI 工具集、远程工具、文档路由、Skills 与 A2A 互操作。
- **记忆与知识**：工作区记忆、持久化会话草稿、分块与检索、向量/BM25/图检索以及 GraphRAG 组件。
- **文档与产物**：常见文档处理流程、工作区范围内的产物管理，以及桌面端预览能力。
- **安全与治理**：密钥泄露检测、提示注入检查、命令护栏、工作区隔离、审批门、策略评估和审计事件。
- **模型与运维**：OpenAI 兼容及厂商适配器、故障转移、Token 计量、指标、链路追踪和评估工具。
- **扩展目录**：Skills、MCP 服务、分身和记忆模板的本地 Bundle，可选市场发现能力。

### 工作流与审批

当前工作流采用高抽象层设计：可以描述 Agent 任务、连接器动作、判断、复核和审批门，不必把每一次底层工具调用画出来。工作流定义支持版本化，并可与运行轨迹一起检查。连接器执行器和 ERP 适配仍在持续建设，现阶段应把工作流编辑器视为可扩展基础，而不是已经完成的低代码产品。

## 快速开始

### 1. 安装 Python 运行时

要求 Python 3.10 及以上，以及 pip 或 uv。下方 `agenticx` 包为上游 Python 运行时；要安装本仓库的 Ontology 发行版，请使用后面的源码安装方式。

~~~bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install agenticx
~~~

从源码安装：

~~~bash
git clone https://github.com/dubianche123/agenticx-agent-workbench.git
cd agenticx-agent-workbench
pip install -e .
~~~

按需安装可选能力：

~~~bash
pip install -e ".[desktop-runtime]"   # 桌面本地后端、PDF/Office 解析、MCP
pip install -e ".[memory]"            # 向量和记忆后端
pip install -e ".[document]"          # 文档解析与 OCR 辅助
pip install -e ".[all]"               # 全部运行时扩展
~~~

配置至少一个模型提供方，例如：

~~~bash
export OPENAI_API_KEY="your-api-key"
agx --version
~~~

示例文件只包含占位符。真实凭据请放在环境变量或密钥管理系统中。

### 2. 运行第一个 Agent

~~~python
from agenticx import Agent, Task, AgentExecutor
from agenticx.llms import OpenAIProvider

agent = Agent(
    id="research-agent",
    name="Research Assistant",
    role="Information gatherer",
    goal="Find and synthesize information clearly",
    organization_id="example-org",
)

task = Task(
    id="research-task",
    description="Summarize the main ideas in multi-agent systems.",
    expected_output="A concise, structured report",
)

executor = AgentExecutor(
    agent=agent,
    llm=OpenAIProvider(model="gpt-4o"),
)
result = executor.run(task)
print(result)
~~~

带工具的完整示例见 docs/guides/first-agent.md。也可以直接用 CLI 生成项目：

~~~bash
agx project create my-agent --template basic
cd my-agent
agx run agent.py --verbose
~~~

### 3. 启动 Studio API

~~~bash
agx serve --port 8000
~~~

Studio 服务通过 REST 和 SSE 提供会话、消息、Agent、工具、Skills、知识库和运行时事件接口。详见 docs/guides/studio.md 与 docs/cli.md。

### 4. 本地启动 Ontology Desktop

要求 Node.js 20 及以上，并已安装可用的 AgenticX Python 环境。

~~~bash
cd desktop
npm install
npm run dev
~~~

开发启动器会运行 Electron 渲染层，并连接本机 AgenticX 服务。桌面端打包、离线 wheelhouse 和安装包命令见 desktop/README.md 与 INSTALL.md。

### 5. 本地启动 Enterprise

要求 Node.js 20 及以上、pnpm 9 及以上、Go 1.22 及以上；本地数据库和 Redis 使用 Docker。

~~~bash
cd enterprise
bash scripts/bootstrap.sh
bash scripts/start-dev.sh --ui=stream
~~~

默认入口：

- Web Portal：http://localhost:3000
- Admin Console：http://localhost:3001
- Gateway 健康检查：http://localhost:8088/healthz

bootstrap 脚本会创建本地配置并要求输入开发凭据。不要提交生成的 .env.local 或 .local-secrets 文件。

## 如何选择入口

| 目标 | 从这里开始 |
| --- | --- |
| 在 Python 中嵌入 Agent | agenticx/ 与 docs/getting-started/ |
| 开发工具、Skill 或 MCP 集成 | docs/concepts/tools.md 与 docs/guides/extensions.md |
| 体验本机多智能体会话 | desktop/README.md |
| 配置企业身份、模型、角色或配额 | enterprise/README.md |
| 设计或运行工作流 | docs/cli.md 与 tests/ 下的工作流测试 |
| 了解安全与隔离 | docs/guides/security.md 与 enterprise/SECURITY.md |

## 离线与自包含打包

自包含桌面安装包会内置本地 AgenticX 后端，首次启动不需要下载 Python 依赖。在联网构建机准备 wheelhouse 后，可随安装包复制到断网机器。完整流程见 INSTALL.md。

常用构建入口：

~~~bash
./packaging/build_dmg.sh arm64
./packaging/build_dmg.sh x64
~~~

Windows 打包见 desktop/README.md 与 packaging/build_windows_installer.ps1。签名和公证需要由发布者提供凭据，仓库中不保存这些信息。

## 开发与测试

Python：

~~~bash
python -m pytest -q
~~~

桌面端：

~~~bash
cd desktop
npm install
npm test
~~~

企业端：

~~~bash
cd enterprise
pnpm install
pnpm typecheck
pnpm test
~~~

部分集成测试需要 Docker、已配置的数据库或模型提供方凭据，请先阅读相应目录的说明。

## 文档

- [文档索引](docs/index.md)
- [安装](docs/getting-started/installation.md)
- [Python 快速开始](docs/getting-started/quickstart.md)
- [CLI 参考](docs/cli.md)
- [Agent 概念](docs/concepts/agent.md)
- [工具与 MCP](docs/concepts/tools.md)
- [记忆与检索](docs/concepts/memory.md)
- [桌面端指南](desktop/README.md)
- [企业端指南](enterprise/README.md)
- [变更记录](docs/changelog.md)
- [路线图](docs/roadmap.md)

## 贡献

欢迎提交 Issue 和 Pull Request。修改前请阅读 CONTRIBUTING.md，并确保凭据、生成产物、本地缓存和部署专用配置不会进入提交。

## 许可证

AgenticX Ontology 采用 Apache License 2.0，详见 [LICENSE](LICENSE)。
