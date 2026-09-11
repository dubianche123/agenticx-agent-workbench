from __future__ import annotations

from copy import deepcopy

from agenticx.runtime.feedback_context import (
    FEEDBACK_LABELS,
    FEEDBACK_PROJECTION_KEY,
    answer_digest_for,
    project_feedback_context,
    question_digest_for,
)


IDENTITY = "desktop\x00tenant-a\x00user-a"
SESSION = "session-a"
SUBJECT = "meta"


def _case(
    *,
    message_id: str = "assistant-1",
    question: str = "请说明电池健康管理方案",
    answer: str = "可以从充电上限、温度控制和周期校准三个方面制定方案。",
    value: str = "like",
    **extra: object,
) -> dict[str, object]:
    return {
        "id": f"feedback-{message_id}",
        "identity_key": IDENTITY,
        "session_id": SESSION,
        "subject_id": SUBJECT,
        "message_id": message_id,
        "question": question,
        "answer": answer,
        "value": value,
        **extra,
    }


def _project(messages: list[dict[str, object]], cases: list[dict[str, object]], **kwargs: object):
    return project_feedback_context(
        messages,
        cases,
        identity_key=IDENTITY,
        session_id=SESSION,
        subject_id=SUBJECT,
        **kwargs,
    )


def test_existing_answer_is_annotated_once_on_copy_without_persisted_mutation() -> None:
    messages = [
        {"role": "user", "content": "请说明电池健康管理方案"},
        {
            "role": "assistant",
            "id": "assistant-1",
            "content": "可以从充电上限、温度控制和周期校准三个方面制定方案。",
            "metadata": {"client_turn_id": "turn-1", "ui": "keep"},
        },
    ]
    before = deepcopy(messages)
    answer = str(messages[1]["content"])

    projected = _project(messages, [_case()])

    assert messages == before
    assert projected[1]["content"].count(answer) == 1
    assert projected[1]["content"].count(FEEDBACK_LABELS["like"]) == 1
    assert projected[1][FEEDBACK_PROJECTION_KEY]["kind"] == "annotation"
    assert projected[1]["metadata"] == before[1]["metadata"]
    assert len(projected) == len(messages)


def test_cancel_or_reversal_removes_stale_marker_on_next_request() -> None:
    messages = [
        {"role": "user", "content": "请说明电池健康管理方案"},
        {"role": "assistant", "id": "assistant-1", "content": "答案"},
    ]
    old = _project(messages, [_case(answer="答案")])
    assert FEEDBACK_LABELS["like"] in old[1]["content"]

    cancelled = project_feedback_context(
        old,
        [],
        identity_key=IDENTITY,
        session_id=SESSION,
        subject_id=SUBJECT,
    )
    assert cancelled[1]["content"] == "答案"
    assert FEEDBACK_PROJECTION_KEY not in cancelled[1]

    reversed_vote = _project(
        old,
        [_case(answer="答案", value="dislike", revision=2)],
    )
    assert FEEDBACK_LABELS["like"] not in reversed_vote[1]["content"]
    assert FEEDBACK_LABELS["dislike"] in reversed_vote[1]["content"]


def test_truncated_legacy_answer_prefix_cannot_match_full_answer() -> None:
    question = "请说明长篇报告的结论"
    full_answer = "A" * 4_000 + "完整答案尾部不能被旧前缀证明。"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "content": full_answer},
    ]
    legacy = _case(question=question, answer=full_answer[:4_000], message_id="legacy-id")

    projected = _project(messages, [legacy])

    assert projected == messages
    assert FEEDBACK_LABELS["like"] not in projected[1]["content"]


def test_repeated_identical_question_and_answer_is_ambiguous_without_identity() -> None:
    question = "请说明重复问题"
    answer = "同一个答案"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "content": answer},
        {"role": "user", "content": question},
        {"role": "assistant", "content": answer},
    ]
    case = _case(
        message_id="legacy-id",
        question=question,
        answer=answer,
    )

    projected = _project(messages, [case])

    assert projected == messages
    assert all(FEEDBACK_LABELS["like"] not in str(row.get("content", "")) for row in projected)


def test_compacted_answer_gets_bounded_same_session_excerpt_with_source() -> None:
    answer = "第一句结论。" + ("后续原文不应完整带入新请求。" * 200)
    messages = [
        {"role": "system", "content": "[compacted] earlier turns"},
        {"role": "user", "content": "继续处理当前任务"},
    ]
    projected = _project(
        messages,
        [_case(answer=answer, message_id="assistant-removed")],
        max_summary_chars=180,
        max_total_chars=220,
    )

    assert len(projected) == len(messages) + 1
    summary = projected[-1]
    assert summary["role"] == "system"
    assert "[feedback excerpt" in summary["content"]
    assert "source=feedback-assistant-removed" in summary["content"]
    assert "第一句结论。" in summary["content"]
    assert len(summary["content"]) <= 220
    assert answer not in summary["content"]


def test_case_metadata_is_not_copied_and_existing_message_metadata_stays_unchanged() -> None:
    messages = [
        {"role": "user", "content": "问题"},
        {
            "role": "assistant",
            "id": "assistant-1",
            "content": "答案",
            "metadata": {"client_turn_id": "turn-1", "original": True},
        },
    ]
    case = _case(answer="答案", turn_id="turn-1", metadata={"secret": "must-not-propagate"})

    projected = _project(messages, [case])

    assert projected[1]["metadata"] == messages[1]["metadata"]
    assert "secret" not in str(projected)
    assert "turn_id" not in projected[1]["metadata"]


def test_multimodal_answer_and_tool_call_pairing_are_preserved() -> None:
    tool_calls = [{"id": "call-1", "type": "function", "function": {"name": "lookup"}}]
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "问题"}, {"type": "image_url", "image_url": {"url": "data:image/x"}}]},
        {
            "role": "assistant",
            "id": "assistant-tool",
            "content": [{"type": "text", "text": "工具前说明"}, {"type": "image_url", "image_url": {"url": "data:image/y"}}],
            "tool_calls": tool_calls,
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "工具结果"},
    ]
    before = deepcopy(messages)
    case = _case(
        message_id="assistant-tool",
        question="问题",
        answer="工具前说明",
    )

    projected = _project(messages, [case])

    assert messages == before
    assert projected[1]["tool_calls"] == tool_calls
    assert projected[2] == messages[2]
    assert projected[1]["content"][1] == messages[1]["content"][1]
    assert projected[1]["content"][-1] == {"type": "text", "text": FEEDBACK_LABELS["like"]}
    assert [row["role"] for row in projected] == ["user", "assistant", "tool"]


def test_identity_session_and_subject_filters_fail_closed() -> None:
    messages = [
        {"role": "user", "content": "问题"},
        {"role": "assistant", "id": "assistant-1", "content": "答案"},
    ]
    case = _case(question="问题", answer="答案")

    assert project_feedback_context(
        messages,
        [case],
        identity_key="other-account",
        session_id=SESSION,
        subject_id=SUBJECT,
    ) == messages
    assert project_feedback_context(
        messages,
        [case],
        identity_key=IDENTITY,
        session_id="other-session",
        subject_id=SUBJECT,
    ) == messages
    assert project_feedback_context(
        messages,
        [case],
        identity_key=IDENTITY,
        session_id=SESSION,
        subject_id="avatar-a",
    ) == messages
    assert project_feedback_context(messages, [case], session_id=SESSION, subject_id=SUBJECT) == messages


def test_content_matching_accepts_explicit_full_digests_and_turn_metadata() -> None:
    question = "无稳定消息 id 的问题"
    answer = "无稳定消息 id 的完整答案"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "content": answer, "metadata": {"client_turn_id": "turn-9"}},
    ]
    case = _case(
        message_id="legacy-message",
        question=question,
        answer=answer,
        question_digest=question_digest_for(question),
        answer_digest=answer_digest_for(answer),
    )
    projected = _project(messages, [case])
    assert FEEDBACK_LABELS["like"] in projected[1]["content"]


def test_literal_feedback_markers_in_original_answer_are_never_removed() -> None:
    answer = "代码示例中要原样保留 [feedback: like]，系统摘要也可写 [feedback excerpt]。"
    messages = [
        {"role": "user", "content": "说明标签格式"},
        {"role": "assistant", "id": "assistant-1", "content": answer},
    ]
    before = deepcopy(messages)

    projected = _project(messages, [_case(question="说明标签格式", answer=answer)])
    cancelled = project_feedback_context(
        projected,
        [],
        identity_key=IDENTITY,
        session_id=SESSION,
        subject_id=SUBJECT,
    )

    assert answer in projected[1]["content"]
    assert projected[1]["content"].count("[feedback: like]") == 2
    assert cancelled[1]["content"] == before[1]["content"]


def test_full_answer_digest_rejects_same_stable_id_with_rewritten_answer() -> None:
    question = "稳定 id 的问题"
    old_answer = "旧答案"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "id": "assistant-1", "content": "同 id 下已经改写的新答案"},
    ]
    case = _case(
        question=question,
        answer=old_answer,
        answer_digest=answer_digest_for(old_answer),
        question_digest=question_digest_for(question),
    )

    projected = _project(messages, [case])

    # The stale id is a hard boundary: the rewritten row is not annotated.
    # Since the voted answer is no longer visible, the bounded source excerpt
    # is carried separately instead of attaching the old vote to new text.
    assert len(projected) == len(messages) + 1
    assert projected[1] == messages[1]
    assert projected[-1]["role"] == "system"
    assert FEEDBACK_LABELS["like"] in projected[-1]["content"]
    assert old_answer not in projected[1]["content"]
    assert FEEDBACK_LABELS["like"] not in projected[1]["content"]


def test_stable_id_mismatch_does_not_fall_back_to_another_duplicate_answer() -> None:
    question = "同一问题"
    old_answer = "旧答案"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "id": "assistant-1", "content": "已改写"},
        {"role": "user", "content": question},
        {"role": "assistant", "content": old_answer},
    ]
    case = _case(
        question=question,
        answer=old_answer,
        answer_digest=answer_digest_for(old_answer),
        question_digest=question_digest_for(question),
    )

    projected = _project(messages, [case])

    assert projected == messages


def test_legacy_stable_id_requires_short_exact_answer_instead_of_id_only() -> None:
    question = "稳定 id 的旧问题"
    old_answer = "旧版本答案"
    new_answer = "同 id 的新版本答案"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "id": "assistant-1", "content": new_answer},
    ]

    projected = _project(
        messages,
        [_case(question=question, answer=old_answer, message_id="assistant-1")],
    )

    assert projected[1] == messages[1]
    assert FEEDBACK_LABELS["like"] not in projected[1]["content"]
    assert len(projected) == len(messages) + 1
    assert old_answer in projected[-1]["content"]
    assert new_answer not in projected[-1]["content"]


def test_legacy_stable_id_at_storage_cap_is_not_treated_as_complete_answer() -> None:
    question = "稳定 id 的截断答案"
    prefix = "A" * 4_000
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "id": "assistant-cap", "content": prefix + "-new-tail"},
    ]

    projected = _project(
        messages,
        [_case(question=question, answer=prefix, message_id="assistant-cap")],
    )

    assert projected == messages
    assert FEEDBACK_LABELS["like"] not in projected[1]["content"]


def test_stable_full_answer_digest_does_not_require_question_digest_or_question_row() -> None:
    answer = "稳定答案的完整正文"
    messages = [{"role": "assistant", "id": "assistant-1", "content": answer}]
    case = _case(
        question="已经被压缩的旧问题",
        answer=answer,
        message_id="assistant-1",
        answer_digest=answer_digest_for(answer),
        question_digest=question_digest_for("另一个问题"),
    )

    projected = _project(messages, [case])

    assert FEEDBACK_LABELS["like"] in projected[0]["content"]
    assert projected[0]["content"].count(answer) == 1


def test_stable_turn_id_is_inherited_from_real_user_history_metadata() -> None:
    question = "带客户端 turn 的问题"
    answer = "没有在 assistant 行重复 turn id 的答案"
    messages = [
        {
            "role": "user",
            "content": question,
            "metadata": {"client_turn_id": "client-turn-9"},
        },
        {"role": "assistant", "content": answer},
    ]
    case = _case(
        message_id="legacy-message",
        question=question,
        answer=answer,
        turn_id="client-turn-9",
        answer_digest=answer_digest_for(answer),
        question_digest=question_digest_for("compressed question differs"),
    )

    projected = _project(messages, [case])

    assert FEEDBACK_LABELS["like"] in projected[1]["content"]
    assert projected[1]["content"].count(answer) == 1


def test_repeated_question_with_different_visible_answer_gets_old_answer_excerpt() -> None:
    question = "同一个问题再次出现"
    old_answer = "旧回答的第一句。旧回答后续正文不应完整复制。"
    new_answer = "后来针对同一问题生成的新回答。"
    messages = [
        {"role": "user", "content": question},
        {"role": "assistant", "content": new_answer},
    ]
    case = _case(
        question=question,
        answer=old_answer,
        message_id="removed-old-answer",
        answer_digest=answer_digest_for(old_answer),
        question_digest=question_digest_for(question),
    )

    projected = _project(messages, [case], max_summary_chars=180, max_total_chars=220)

    assert projected[1] == messages[1]
    assert FEEDBACK_LABELS["like"] not in projected[1]["content"]
    assert len(projected) == len(messages) + 1
    summary = projected[-1]["content"]
    assert "[feedback excerpt" in summary
    assert FEEDBACK_LABELS["like"] in summary
    assert "旧回答的第一句。" in summary
    assert new_answer not in summary
    assert old_answer not in summary


def test_overlong_opaque_scope_values_are_rejected_without_prefix_matching() -> None:
    messages = [
        {"role": "user", "content": "问题"},
        {"role": "assistant", "id": "assistant-1", "content": "答案"},
    ]
    long_session = "s" * 512 + "-different"
    long_subject = "a" * 256 + "-different"
    long_identity = "i" * 4_096 + "-different"

    for field, value in (
        ("session_id", long_session),
        ("subject_id", long_subject),
        ("identity_key", long_identity),
    ):
        case = _case(question="问题", answer="答案", **{field: value})
        projected = project_feedback_context(
            messages,
            [case],
            identity_key=value if field == "identity_key" else IDENTITY,
            session_id=value if field == "session_id" else SESSION,
            subject_id=value if field == "subject_id" else SUBJECT,
        )
        assert projected == messages


def test_tuple_multimodal_content_is_preserved_and_cancelled_without_loss() -> None:
    image_block = {"type": "image_url", "image_url": {"url": "data:image/png"}}
    original_content = (
        {"type": "text", "text": "答案说明"},
        image_block,
    )
    messages = [
        {"role": "user", "content": "问题"},
        {"role": "assistant", "id": "assistant-tuple", "content": original_content},
    ]
    case = _case(
        message_id="assistant-tuple",
        question="问题",
        answer="答案说明",
    )

    projected = _project(messages, [case])

    assert isinstance(projected[1]["content"], tuple)
    assert projected[1]["content"][:2] == original_content
    assert projected[1]["content"][-1] == {"type": "text", "text": FEEDBACK_LABELS["like"]}

    cancelled = project_feedback_context(
        projected,
        [],
        identity_key=IDENTITY,
        session_id=SESSION,
        subject_id=SUBJECT,
    )

    assert cancelled[1]["content"] == original_content
    assert isinstance(cancelled[1]["content"], tuple)
    assert FEEDBACK_PROJECTION_KEY not in cancelled[1]
