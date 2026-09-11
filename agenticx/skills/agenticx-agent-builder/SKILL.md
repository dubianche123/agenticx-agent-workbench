---
name: agenticx-agent-builder
description: Guide for creating persistent Near desktop digital avatars (数字分身) via natural-language interview and the create_avatar tool. Use when the user wants to create an avatar, digital twin, specialist agent persona, or add someone to the avatar sidebar.
metadata:
  author: AgenticX
  version: "0.6.0"
---

# Near Digital Avatar Builder

Help the user create a **persistent desktop digital avatar (数字分身)** that appears in the Near sidebar avatar list.

## Hard rules

1. **Must call `create_avatar`** after clarifying and distilling the config. That tool writes the avatar into the registry and makes it appear in the sidebar.
2. The confirmation proposal must include the default permission mode (`plan`, `ask`, or `auto`) and the initial core-memory plan. When risk is unclear, use `ask`.
3. Pass safe, non-sensitive initial documents through `core_memory` when they are useful:
   `{"SOUL.md": "...", "MEMORY.md": "..."}`. `IDENTITY.md` is created by the registry and must not be supplied by the model.
4. **Do NOT** only write a Markdown file to Desktop / workspace and claim the avatar is created. The `create_avatar` handler persists the fixed core documents through the registry safety API.
5. Never pass or invent `workspace_dir`. New experts receive a system-assigned isolated workspace; a model must not select an arbitrary local path.
6. **Do NOT** tell the user there is "no create-avatar API" — `create_avatar` is the API.
7. **Do NOT** ask the user to open「+ 新建」and fill the manual form unless they explicitly want the GUI.
8. **Do NOT** invent Python SDK / `AgentExecutor` / `agx agent create` workflows for this task — those are code-layer agents, not Near desktop avatars.

## Interview flow (2–3 rounds, not a long questionnaire)

Ask only what is still missing. Prefer short choices (clarification / `show_widget`) over open essays.

### Round 1 — Positioning

- What should this avatar own? (domain / job)
- Who is it for? (usually the current user)

### Round 2 — Scope & style

- Coverage (markets, stacks, products, languages…)
- Analysis / work style (trading vs research, concise vs thorough, etc.)

### Round 3 — Boundaries (only if needed)

- Risk preference / what it must never do
- Preferred output structure
- Optional default model

Stop early when you already have enough to write a solid `name` / `role` / `system_prompt`.
Do not ask the user to choose fields that can be inferred safely. Keep `MEMORY.md` empty or use only stable, non-sensitive facts when there is no explicit memory to preserve.

## Distill into these fields

| Field | Meaning | Example |
|---|---|---|
| `name` | Short character-like display name | 飞廉 |
| `role` | One-line positioning | 进取型全市场交易分析师 |
| `description` | One- or two-sentence gallery-card blurb / profile signature | 关注风险边界，输出可执行的市场判断 |
| `tags` | Up to 8 short capability tags | `["基本面", "风险控制"]` |
| `system_prompt` | Full behavior contract | See template below |
| `default_permission_mode` | Default run permission: `plan`, `ask`, or `auto`; use `ask` if unclear | `ask` |
| `core_memory` | Optional initial fixed documents; only `SOUL.md` and `MEMORY.md` | `{ "SOUL.md": "...", "MEMORY.md": "..." }` |
| `default_provider` / `default_model` | Optional; omit to inherit global default | |

The workspace is intentionally not a user/model field. The registry assigns the isolated workspace automatically.

### `system_prompt` should include

- Identity & coverage
- Analysis / work priorities
- Risk preference & hard boundaries
- Data discipline (no fabricated numbers / facts)
- Output style & fixed structure when useful
- Disclaimer when the domain needs one (finance, medical, legal, etc.)

## Landing step (required)

Call:

```text
create_avatar(
  name=...,
  role=...,
  description=...,
  tags=[...],
  system_prompt=...,
  default_permission_mode="ask",
  core_memory={
    "SOUL.md": "...",
    "MEMORY.md": "...",
  },
  default_provider=optional,
  default_model=optional
)
```

Then confirm to the user:

- The avatar is in the sidebar list
- They can open it or `@` it in group chat
- Its default permission and core documents were persisted in its isolated workspace
- Optionally offer follow-ups: schedule automation, tweak prompt, set default model

### If `create_avatar` returns `avatar_exists`

Do **not** create a duplicate. Tell the user it already exists and offer:

- `delegate_to_avatar(avatar_id=..., task=...)` for work
- Or update via settings / a later update tool if they want changes

## Anti-patterns

- Saying "半搞定" after only drafting a prompt file
- Dumping a long YAML/Markdown archive without calling `create_avatar`
- Writing `IDENTITY.md`/`SOUL.md`/`MEMORY.md` through an arbitrary filesystem path instead of `core_memory`
- Passing `workspace_dir` selected or invented by the model
- Asking the user to copy-paste into the create-avatar form
- Confusing temporary `spawn_subagent` workers with persistent avatars
- Using `spawn_subagent` with the same name as a registered avatar

## Example success path

User: "帮我创建一个数字分身专门帮我分析金融市场"

1. Clarify markets / style / risk preference (2–3 choices)
2. Distill `name=飞廉`, `role=进取型全市场交易分析师`, `description`, `tags`, and a full `system_prompt`; choose `default_permission_mode="ask"` unless the user clearly requests another mode.
3. Show one confirmation proposal containing those fields and the planned `SOUL.md`/`MEMORY.md` content.
4. After confirmation, call `create_avatar(...)` with the approved fields and no `workspace_dir`.
5. Reply: 飞廉已加入分身列表，可直接点开或 @ 它
