#!/usr/bin/env python3
"""User-configured path rules (``permissions.path_rules``).

设置界面里对这组规则的承诺是：**「按 glob 模式匹配文件路径，决定允许或拒绝访问。
规则按顺序匹配，首个命中生效。」** 这个模块负责让那句话成真——在 2026-08-24 之前
它只被设置接口读写，执行路径上无人检查。

两档语义，对齐 Claude Code 的 deny > allow 次序：

``allow: false``（拒绝）
    **绝对拒绝**，在确认闸之前短路，不提供「批准一次」。用户写下一条禁令，就不该再被
    问要不要破例。

``allow: true``（允许）
    **免确认**，不是「放开沙箱」。它的作用等价于 Claude 的 ``Edit(src/**)``：这条路径
    上的写不再逐次弹框。它**不能**让路径越出工作区——工作区边界由沙箱和
    ``_resolve_workspace_path`` 负责，一条配置项不该有拆掉它的能力。
    （否则一条手滑写成 ``/**`` 的 allow 规则就把整个隔离作废了。）

Author: Damon Li
"""

from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

#: 一条规则命中后的判定。``None`` 表示没有任何规则命中。
PathDecision = Optional[bool]


def normalize_path_rules(raw: Any) -> list[tuple[str, bool]]:
    """Return ``[(pattern, allow), …]`` from whatever the config holds.

    配置是人手写的（也可能被别的工具改过），所以坏值一律跳过而不是抛异常：
    执行路径上因为一条畸形规则整个炸掉，比忽略那条规则更糟。
    """
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[tuple[str, bool]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        pattern = str(entry.get("pattern", "") or "").strip()
        if not pattern:
            continue
        # 与前端一致：只有显式 false 才是拒绝，缺省视为允许。
        out.append((pattern, entry.get("allow") is not False))
    return out


def match_path_rules(
    path: str | Path,
    rules: Sequence[tuple[str, bool]],
) -> tuple[PathDecision, str]:
    """Deny wins globally; among allows, the first match wins.

    这里曾经是「首个命中生效」（照抄设置界面的旧文案），但那和「deny 是绝对的」自相
    矛盾：写成 ``allow *`` 在前、``deny */.env`` 在后，``.env`` 就被放行了——用户明明
    写下了一条禁令。次序敏感的安全规则也很难让人一眼看出后果。

    改成先扫全部 deny：任何一条 deny 命中就拒绝，与它排在第几无关。都没命中时，
    再按顺序取第一条 allow。与 Claude Code 的 deny > allow 一致。设置界面的说明文案
    已同步改写。

    Args:
        path: 已解析的绝对路径。
        rules: :func:`normalize_path_rules` 的输出。

    Returns:
        ``(decision, pattern)``。``decision`` 为 ``None`` 时 ``pattern`` 是空串。
    """
    text = str(path)
    # glob 习惯上按 / 书写；Windows 路径同时按原样和正斜杠形式比对，免得规则在
    # 另一个平台上突然不生效。
    candidates = {text, text.replace("\\", "/")}

    def _hits(pattern: str) -> bool:
        shapes = {pattern, pattern.replace("\\", "/")}
        return any(
            fnmatch.fnmatch(candidate, shape)
            for candidate in candidates
            for shape in shapes
        )

    for pattern, allow in rules:
        if not allow and _hits(pattern):
            return False, pattern
    for pattern, allow in rules:
        if allow and _hits(pattern):
            return True, pattern
    return None, ""


def path_rule_decision(
    path: str | Path,
    raw_rules: Any,
) -> tuple[PathDecision, str]:
    """Convenience wrapper: normalize then match."""
    return match_path_rules(path, normalize_path_rules(raw_rules))
