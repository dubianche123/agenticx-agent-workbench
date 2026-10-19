# AgenticX M8.5: 多智能体协作框架

## 概述

AgenticX M8.5多智能体协作框架实现了8种核心协作模式，支持从简单任务分发到复杂团队协作的全场景覆盖。基于MAS（Multi-Agent System）理论，提供标准化的协作模式实现。

## 架构设计

### 核心组件

```
agenticx/collaboration/
├── __init__.py          # 模块初始化，导出主要组件
├── enums.py             # 协作模式枚举和状态定义
├── config.py            # 配置模型定义
├── base.py              # 基础抽象类和数据模型
├── patterns.py          # 协作模式实现
├── manager.py           # 协作管理器
├── memory.py            # 协作记忆系统
└── metrics.py           # 协作指标收集器
```

### 设计原则

1. **模块化设计**: 每个组件独立，易于扩展
2. **配置驱动**: 通过配置控制行为
3. **事件驱动**: 基于事件的协作流程
4. **可观测性**: 完整的监控和指标收集
5. **错误恢复**: 完善的错误处理机制

## 🤝 8种协作模式

### 1. 主从层次模式 (Master-Slave)

**适用场景**: 需要层次化任务分解和协调的场景

**特点**:
- 主控智能体负责任务规划和结果聚合
- 从属智能体执行具体任务
- 支持任务分解和分配
- 层次化规划和协调

**代码示例**:

```python
from agenticx.collaboration.enums import CollaborationMode
from agenticx.collaboration.config import MasterSlaveConfig
from agenticx.collaboration.patterns import MasterSlavePattern
from agenticx.core.agent import Agent

# 创建智能体
master_agent = Agent(
    id="master_001",
    name="Master Agent",
    role="master",
    goal="负责任务规划和结果聚合",
    organization_id="demo_org"
)

slave_agent = Agent(
    id="slave_001", 
    name="Slave Agent",
    role="slave",
    goal="执行具体任务",
    organization_id="demo_org"
)

# 创建主从协作
config = MasterSlaveConfig(
    mode=CollaborationMode.MASTER_SLAVE,
    master_agent_id=master_agent.id,
    slave_agent_ids=[slave_agent.id],
    enable_hierarchical_planning=True,
    enable_result_aggregation=True
)

collaboration = MasterSlavePattern(
    master_agent=master_agent,
    slave_agents=[slave_agent],
    config=config
)

# 执行协作任务
result = collaboration.execute("分析人工智能在医疗领域的应用前景")
print(f"成功: {result.success}")
print(f"结果: {result.result}")
```

### 2. 反思模式 (Reflection)

**适用场景**: 需要质量改进和迭代优化的场景

**特点**:
- 执行智能体负责初始解决方案
- 审查智能体提供反馈和改进建议
- 支持迭代优化和质量评估
- 收敛判断机制

**代码示例**:

```python
from agenticx.collaboration.config import ReflectionConfig
from agenticx.collaboration.patterns import ReflectionPattern

# 创建智能体
executor_agent = Agent(
    id="executor_001",
    name="Executor Agent",
    role="executor",
    goal="负责具体任务执行",
    organization_id="demo_org"
)

reviewer_agent = Agent(
    id="reviewer_001",
    name="Reviewer Agent", 
    role="reviewer",
    goal="负责质量评估和改进建议",
    organization_id="demo_org"
)

# 创建反思协作
config = ReflectionConfig(
    mode=CollaborationMode.REFLECTION,
    max_iterations=5,
    quality_threshold=0.8,
    enable_auto_convergence=True
)

collaboration = ReflectionPattern(
    executor_agent=executor_agent,
    reviewer_agent=reviewer_agent,
    config=config
)

# 执行协作任务
result = collaboration.execute("设计一个智能客服系统")
print(f"迭代次数: {result.iteration_count}")
print(f"最终质量: {result.quality_score}")
```

### 3. 辩论模式 (Debate)

**适用场景**: 需要多角度分析和决策的场景

**特点**:
- 多个辩论者从不同角度分析问题
- 聚合者综合各方观点
- 支持结构化辩论流程
- 最终决策生成

**代码示例**:

```python
# 创建辩论智能体
debaters = [
    Agent(id="debater_1", name="Optimist", role="debater", goal="乐观角度分析", organization_id="demo_org"),
    Agent(id="debater_2", name="Pessimist", role="debater", goal="悲观角度分析", organization_id="demo_org"),
    Agent(id="debater_3", name="Realist", role="debater", goal="现实角度分析", organization_id="demo_org")
]

aggregator = Agent(
    id="aggregator_1",
    name="Aggregator",
    role="aggregator", 
    goal="综合各方观点",
    organization_id="demo_org"
)

# 创建辩论协作
collaboration = DebatePattern(
    debaters=debaters,
    aggregator=aggregator,
    config=DebateConfig(
        mode=CollaborationMode.DEBATE,
        max_rounds=3,
        enable_voting=True
    )
)

# 执行辩论
result = collaboration.execute("评估AI对就业市场的影响")
print(f"辩论轮次: {result.debate_rounds}")
print(f"最终决策: {result.final_decision}")
```

### 4. 群聊模式 (Group Chat)

**适用场景**: 需要自由讨论和集体智慧的场景

**特点**:
- 多个智能体自由交流
- 支持动态话题切换
- 集体智慧汇聚
- 自然语言交互

**代码示例**:

```python
# 创建群聊智能体
agents = [
    Agent(id="agent_1", name="Expert A", role="expert", goal="技术专家", organization_id="demo_org"),
    Agent(id="agent_2", name="Expert B", role="expert", goal="业务专家", organization_id="demo_org"),
    Agent(id="agent_3", name="Expert C", role="expert", goal="用户专家", organization_id="demo_org")
]

# 创建群聊协作
collaboration = GroupChatPattern(
    agents=agents,
    config=GroupChatConfig(
        mode=CollaborationMode.GROUP_CHAT,
        max_messages=50,
        enable_topic_control=True
    )
)

# 开始群聊
result = collaboration.execute("讨论下一代AI产品的设计理念")
print(f"消息数量: {result.message_count}")
print(f"讨论摘要: {result.summary}")
```

### 5. 并行模式 (Parallel)

**适用场景**: 需要同时处理多个独立任务的场景

**特点**:
- 多个智能体并行工作
- 独立任务分配
- 结果合并和整合
- 负载均衡

**代码示例**:

```python
# 创建并行智能体
agents = [
    Agent(id="worker_1", name="Worker A", role="worker", goal="处理任务A", organization_id="demo_org"),
    Agent(id="worker_2", name="Worker B", role="worker", goal="处理任务B", organization_id="demo_org"),
    Agent(id="worker_3", name="Worker C", role="worker", goal="处理任务C", organization_id="demo_org")
]

# 创建并行协作
collaboration = ParallelPattern(
    agents=agents,
    config=ParallelConfig(
        mode=CollaborationMode.PARALLEL,
        enable_load_balancing=True,
        max_concurrent_tasks=3
    )
)

# 执行并行任务
tasks = ["分析数据A", "分析数据B", "分析数据C"]
result = collaboration.execute(tasks)
print(f"完成的任务数: {result.completed_tasks}")
print(f"并行结果: {result.parallel_results}")
```

### 6. 嵌套模式 (Nested)

**适用场景**: 需要复杂任务分解和子协作的场景

**特点**:
- 支持协作嵌套
- 复杂任务分解
- 子协作管理
- 结果层次化整合

**代码示例**:

```python
# 创建嵌套协作
parent_agents = [
    Agent(id="parent_1", name="Coordinator", role="coordinator", goal="协调子协作", organization_id="demo_org")
]

sub_agents = [
    Agent(id="sub_1", name="Sub Agent A", role="worker", goal="子任务A", organization_id="demo_org"),
    Agent(id="sub_2", name="Sub Agent B", role="worker", goal="子任务B", organization_id="demo_org")
]

# 创建嵌套协作
collaboration = NestedPattern(
    parent_agents=parent_agents,
    sub_collaborations=[
        MasterSlavePattern(sub_agents[0], [sub_agents[1]]),
        ReflectionPattern(sub_agents[0], sub_agents[1])
    ],
    config=NestedConfig(
        mode=CollaborationMode.NESTED,
        max_nesting_level=3
    )
)

# 执行嵌套协作
result = collaboration.execute("复杂项目管理和执行")
print(f"嵌套层级: {result.nesting_level}")
print(f"子协作结果: {result.sub_results}")
```

### 7. 动态模式 (Dynamic)

**适用场景**: 需要动态添加和移除智能体的场景

**特点**:
- 动态智能体管理
- 运行时协作调整
- 自适应协作结构
- 智能体生命周期管理

**代码示例**:

```python
# 创建动态协作
base_agents = [
    Agent(id="base_1", name="Base Agent", role="coordinator", goal="基础协调", organization_id="demo_org")
]

# 创建动态协作
collaboration = DynamicPattern(
    base_agents=base_agents,
    config=DynamicConfig(
        mode=CollaborationMode.DYNAMIC,
        enable_auto_scaling=True,
        max_agents=10
    )
)

# 执行动态协作
result = collaboration.execute("动态任务处理")
print(f"最终智能体数: {result.final_agent_count}")
print(f"动态调整次数: {result.adjustment_count}")
```

### 8. 异步模式 (Async)

**适用场景**: 需要长时间运行和异步处理的场景

**特点**:
- 异步任务处理
- 长时间运行支持
- 状态持久化
- 进度监控

**代码示例**:

```python
# 创建异步协作
agents = [
    Agent(id="async_1", name="Async Worker A", role="worker", goal="异步任务A", organization_id="demo_org"),
    Agent(id="async_2", name="Async Worker B", role="worker", goal="异步任务B", organization_id="demo_org")
]

# 创建异步协作
collaboration = AsyncPattern(
    agents=agents,
    config=AsyncConfig(
        mode=CollaborationMode.ASYNC,
        enable_persistence=True,
        max_execution_time=3600
    )
)

# 执行异步协作
result = collaboration.execute("长时间数据分析任务")
print(f"执行状态: {result.status}")
print(f"进度: {result.progress}%")
```

## 🛠️ 使用指南

### 基本使用流程

1. **创建智能体**
```python
from agenticx.core.agent import Agent

agent = Agent(
    id="agent_001",
    name="My Agent",
    role="worker",
    goal="执行特定任务",
    organization_id="my_org"
)
```

2. **选择协作模式**
```python
from agenticx.collaboration.enums import CollaborationMode

# 根据任务需求选择合适的协作模式
mode = CollaborationMode.MASTER_SLAVE  # 或其他模式
```

3. **创建协作管理器**
```python
from agenticx.collaboration.manager import CollaborationManager
from agenticx.collaboration.config import CollaborationManagerConfig

config = CollaborationManagerConfig(
    default_timeout=300.0,
    max_concurrent_collaborations=10
)
manager = CollaborationManager(config)
```

4. **创建协作实例**
```python
collaboration = manager.create_collaboration(
    pattern=CollaborationMode.MASTER_SLAVE,
    agents=[master_agent, slave_agent]
)
```

5. **执行协作任务**
```python
result = collaboration.execute("任务描述")
print(f"成功: {result.success}")
print(f"结果: {result.result}")
print(f"执行时间: {result.execution_time:.2f}秒")
```

### 高级功能

#### 协作监控
```python
# 监控协作状态
status = manager.monitor_collaboration(collaboration.collaboration_id)
print(f"状态: {status['status']}")
print(f"当前迭代: {status['current_iteration']}")

# 获取统计信息
stats = manager.get_collaboration_statistics()
print(f"总协作数: {stats['total_collaborations']}")
print(f"活跃协作数: {stats['active_collaborations']}")
```

#### 协作记忆
```python
from agenticx.collaboration.memory import CollaborationMemory

memory = CollaborationMemory()
memory.store_event(collaboration.collaboration_id, "task_started", {"task": "分析任务"})

# 检索历史
history = memory.get_collaboration_history(collaboration.collaboration_id)
print(f"历史事件数: {len(history)}")
```

#### 性能指标
```python
from agenticx.collaboration.metrics import CollaborationMetrics

metrics = CollaborationMetrics()
efficiency = metrics.calculate_efficiency(collaboration.collaboration_id)
print(f"协作效率: {efficiency}")

report = metrics.generate_report()
print(f"详细报告: {report}")
```

## 性能指标

### 当前实现性能
- **响应时间**: < 1秒 (基础操作)
- **内存使用**: 低内存占用
- **并发支持**: 支持多协作并发
- **错误率**: < 5% (基础功能)

### 优化建议
1. **LLM集成**: 集成实际LLM模型
2. **缓存机制**: 添加结果缓存
3. **异步处理**: 支持异步协作
4. **负载均衡**: 智能体负载均衡
5. **资源管理**: 优化资源使用

## 配置说明

### 基础配置
```python
from agenticx.collaboration.config import CollaborationConfig

config = CollaborationConfig(
    timeout=300.0,
    max_iterations=10,
    enable_logging=True,
    enable_metrics=True
)
```

### 管理器配置
```python
from agenticx.collaboration.config import CollaborationManagerConfig

manager_config = CollaborationManagerConfig(
    default_timeout=300.0,
    max_concurrent_collaborations=10,
    enable_auto_cleanup=True,
    cleanup_interval=3600
)
```

### 记忆系统配置
```python
from agenticx.collaboration.config import CollaborationMemoryConfig

memory_config = CollaborationMemoryConfig(
    max_history_size=1000,
    enable_compression=True,
    retention_days=30
)
```

## 🧪 测试和验证

### 运行基础测试
```bash
python test_collaboration_basic.py
```

### 运行演示脚本
```bash
python examples/collaboration_demo.py
```

### 测试结果示例
```
✅ 基本导入成功
✅ 智能体创建成功
✅ 管理器创建成功
✅ 协作模式枚举成功 (8种模式)
✅ 管理器功能测试通过
```

## 🚀 扩展开发

### 添加新的协作模式

1. **定义枚举**
```python
# 在 enums.py 中添加
class CollaborationMode(Enum):
    CUSTOM_PATTERN = "custom_pattern"
```

2. **创建配置类**
```python
# 在 config.py 中添加
class CustomPatternConfig(CollaborationConfig):
    custom_param: str = "default_value"
```

3. **实现协作模式**
```python
# 在 patterns.py 中添加
class CustomPattern(BaseCollaborationPattern):
    def __init__(self, agents: List[Agent], **kwargs):
        super().__init__(agents, kwargs.get('config'))
    
    def execute(self, task: str, **kwargs) -> CollaborationResult:
        # 实现具体的协作逻辑
        pass
```

4. **注册到管理器**
```python
# 在 manager.py 中添加模式映射
pattern_classes = {
    CollaborationMode.CUSTOM_PATTERN: CustomPattern,
    # ... 其他模式
}
```

## 📚 参考资料

- [AgenticX项目主页](https://github.com/dubianche123/agenticx-agent-workbench)
- [多Agent协作模式](https://arxiv.org/abs/2501.06322)