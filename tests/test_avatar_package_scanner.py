#!/usr/bin/env python3
"""Privacy scanner tests for portable digital expert packages."""

from __future__ import annotations

import json

import pytest

from agenticx.avatar.package_scanner import (
    MAX_SCAN_FINDINGS,
    PackageContentBlockedError,
    PackageScanner,
)


def test_report_detects_secrets_and_never_contains_source_values() -> None:
    secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"
    scanner = PackageScanner()
    report = scanner.scan_fields({"payload.system_prompt": f"token={secret}"})

    assert report.should_block is True
    assert any(finding.rule_id == "secret.openai_api_key" for finding in report.findings)
    encoded = json.dumps(report.to_dict(), ensure_ascii=False)
    assert secret not in encoded
    assert secret[:4] not in encoded
    assert all(not hasattr(finding, "matched_text") for finding in report.findings)


@pytest.mark.parametrize(
    ("value", "rule_id"),
    [
        ("银行卡：4111 1111 1111 1111", "pii.payment_card"),
        ("身份证：11010519491231002X", "pii.cn_identity_number"),
    ],
)
def test_checksum_valid_strong_pii_is_blocking(value: str, rule_id: str) -> None:
    scanner = PackageScanner()
    with pytest.raises(PackageContentBlockedError) as caught:
        scanner.scan_and_block({"resources[0].content": value})
    assert any(finding.rule_id == rule_id for finding in caught.value.report.findings)
    assert value not in str(caught.value)


def test_invalid_card_and_identity_checksums_do_not_block() -> None:
    report = PackageScanner().scan_fields(
        {
            "resource": (
                "无效卡号 4111 1111 1111 1112；"
                "无效身份证 110105194912310021"
            )
        }
    )
    assert not any(
        finding.rule_id in {"pii.payment_card", "pii.cn_identity_number"}
        for finding in report.findings
    )
    assert report.should_block is False


def test_uuid_fragments_are_not_payment_cards_but_hyphenated_cards_still_are() -> None:
    scanner = PackageScanner()
    uuid_report = scanner.scan_fields(
        {"package.artifact_id": "expert:fa772152-5755-4297-be31-c5ba1a6c18f7"}
    )
    assert not any(
        finding.rule_id == "pii.payment_card" for finding in uuid_report.findings
    )

    with pytest.raises(PackageContentBlockedError) as caught:
        scanner.scan_and_block({"resource": "银行卡：4111-1111-1111-1111"})
    assert any(
        finding.rule_id == "pii.payment_card" for finding in caught.value.report.findings
    )


def test_structured_id_fields_still_scan_email_and_phone_pii() -> None:
    report = PackageScanner().scan_fields(
        {"package.artifact_id": "expert:alice@example.com-13800138000"}
    )

    assert {finding.rule_id for finding in report.findings} >= {
        "pii.email",
        "pii.cn_phone",
    }


def test_phone_and_email_are_non_blocking_review_findings() -> None:
    report = PackageScanner().scan_fields(
        {"resource": "联系 13800138000 或 alice@example.com"}
    )
    assert {finding.rule_id for finding in report.findings} >= {
        "pii.cn_phone",
        "pii.email",
    }
    assert report.should_block is False
    PackageScanner().scan_and_block(
        {"resource": "联系 13800138000 或 alice@example.com"}
    )


@pytest.mark.parametrize(
    ("secret", "rule_id"),
    [
        (
            "sk-proj-abc_DEF-ghi_JKL-mno_PQR-stu_VWX",
            "secret.openai_api_key_extended",
        ),
        ("AIza" + ("A" * 35), "secret.google_api_key"),
        (
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
            "secret.jwt",
        ),
        ("postgresql://alice:do-not-publish@db.internal/app", "secret.credential_url"),
        (
            "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890ABCD",
            "secret.aws_secret_access_key",
        ),
        (
            "API_KEY=ABC_def-1234567890-secret",
            "secret.credential_assignment_case_insensitive",
        ),
        (
            "CLIENT_SECRET=ABC_def-1234567890-secret",
            "secret.credential_assignment_case_insensitive",
        ),
        (
            "ACCESS_TOKEN=ABC_def-1234567890-secret",
            "secret.credential_assignment_case_insensitive",
        ),
        (
            "gho_abcdefghijklmnopqrstuvwxyz012345",
            "secret.github_token_extended",
        ),
        (
            "ASIAABCDEFGHIJKLMNOP",
            "secret.aws_access_key_extended",
        ),
        (
            "amqp://worker:do-not-publish@mq.internal/vhost",
            "secret.credential_url",
        ),
        (
            "BEARER ABC_def-1234567890-secret-token",
            "secret.bearer_token_case_insensitive",
        ),
    ],
)
def test_additional_common_credentials_are_blocked(secret: str, rule_id: str) -> None:
    report = PackageScanner().scan_fields({"resource": secret})
    assert report.should_block is True
    assert any(finding.rule_id == rule_id for finding in report.findings)
    assert secret not in json.dumps(report.to_dict(), ensure_ascii=False)


def test_finding_cap_cannot_hide_a_later_blocking_secret() -> None:
    emails = " ".join(f"user{i}@example.com" for i in range(1000))
    report = PackageScanner().scan_fields(
        {
            "resources[0].content": emails,
            "payload.system_prompt": "CLIENT_SECRET=ABC_def-1234567890-secret",
        }
    )
    assert len(report.findings) <= MAX_SCAN_FINDINGS
    assert report.should_block is True
    assert any(
        finding.rule_id == "secret.credential_assignment_case_insensitive"
        for finding in report.findings
    )
