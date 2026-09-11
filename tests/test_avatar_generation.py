"""The AI expert generation route materializes the complete onboarding contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agenticx.avatar import registry as avatar_registry_module
from agenticx.studio import server as server_module
from agenticx.studio.server import create_studio_app


@pytest.fixture(autouse=True)
def isolated_avatar_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the registry isolated even after tests that override its lazy root."""

    root = tmp_path / "avatars"
    # ``AVATARS_ROOT`` is exposed through the module's PEP 562 ``__getattr__``
    # fallback.  ``monkeypatch.setattr`` first calls ``getattr`` and would save
    # that dynamic HOME-derived fallback as a real module attribute, pinning
    # the next test to this test's temporary HOME during teardown.  Patch the
    # module dictionary directly so the missing key is restored as missing.
    monkeypatch.setitem(avatar_registry_module.__dict__, "AVATARS_ROOT", root)
    return root


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content


class _GenerationLLM:
    def __init__(self) -> None:
        self.prompt = ""

    def invoke(self, messages, **_kwargs):
        self.prompt = str(messages[0]["content"])
        return _FakeResponse(
            json.dumps(
                {
                    "name": "前端审查官",
                    "role": "前端代码质量顾问",
                    "signature": "把复杂界面变成可验证的工程质量。",
                    "tags": ["代码审查", "React", "可访问性"],
                    "system_prompt": "先检查证据，再给出最小、可回归的前端修改建议。",
                    "default_permission_mode": "plan",
                    # A model-provided path must never become the expert workspace.
                    "workspace_dir": "/tmp/model-chosen-path",
                }
            )
        )


def test_generate_avatar_materializes_profile_defaults_and_core_memory(
    monkeypatch, tmp_path: Path, isolated_avatar_root: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    llm = _GenerationLLM()
    monkeypatch.setattr(server_module.ProviderResolver, "resolve", lambda **_kwargs: llm)

    app = create_studio_app()
    with TestClient(app) as client:
        response = client.post(
            "/api/avatars/generate",
            json={"description": "请做一个能审查前端代码的专家"},
        )

    assert response.status_code == 200
    avatar = response.json()["avatar"]
    assert avatar["name"] == "前端审查官"
    assert avatar["role"] == "前端代码质量顾问"
    assert avatar["description"] == "把复杂界面变成可验证的工程质量。"
    assert avatar["tags"] == ["代码审查", "React", "可访问性"]
    assert avatar["default_permission_mode"] == "plan"
    workspace = Path(avatar["workspace_dir"])
    assert workspace.is_dir()
    assert workspace != Path("/tmp/model-chosen-path")
    assert workspace == isolated_avatar_root / avatar["id"] / "workspace"

    assert (workspace / "IDENTITY.md").is_file()
    assert (workspace / "MEMORY.md").is_file()
    assert (workspace / "SOUL.md").read_text(encoding="utf-8") == (
        "# SOUL.md - 前端审查官\n\n"
        "先检查证据，再给出最小、可回归的前端修改建议。\n"
    )
    assert "signature" in llm.prompt
    assert "default_permission_mode" in llm.prompt
    assert "workspace_dir MUST be an empty string" in llm.prompt
    assert "IDENTITY.md and MEMORY.md" in llm.prompt


def test_generate_avatar_uses_safe_defaults_for_partial_or_invalid_model_output(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))

    class _PartialLLM:
        def invoke(self, *_args, **_kwargs):
            return _FakeResponse(
                json.dumps(
                    {
                        "name": "默认专家",
                        "tags": "研究, 研究, 分析",
                        "default_permission_mode": "dangerous",
                    }
                )
            )

    monkeypatch.setattr(
        server_module.ProviderResolver,
        "resolve",
        lambda **_kwargs: _PartialLLM(),
    )
    app = create_studio_app()
    with TestClient(app) as client:
        response = client.post(
            "/api/avatars/generate",
            json={"description": "只给出一个名称也应该能完成创建"},
        )

    assert response.status_code == 200
    avatar = response.json()["avatar"]
    assert avatar["role"] == "通用数字专家"
    assert avatar["description"] == "通用数字专家，按需提供结构化、可执行的协助。"
    assert avatar["tags"] == ["研究", "分析"]
    assert avatar["default_permission_mode"] == "ask"
    assert (Path(avatar["workspace_dir"]) / "SOUL.md").is_file()
