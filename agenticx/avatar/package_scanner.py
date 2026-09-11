#!/usr/bin/env python3
"""Privacy and secret scanner for portable expert package content.

The scanner reports *where* and *which rule* matched, but deliberately never
stores the matched text (even a masked preview).  This makes scan reports safe
to persist in an audit record without turning that record into a second secret
store.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Mapping, Sequence

from agenticx.safety.leak_detector import (
    LeakAction,
    LeakDetector,
    LeakPattern,
    LeakSeverity,
)


SCANNER_VERSION = "1"
MAX_SCAN_FINDINGS = 128


@dataclass(frozen=True)
class PackageScanFinding:
    """One privacy/secret finding without any captured source value."""

    rule_id: str
    category: str
    severity: str
    blocking: bool
    field: str
    line: int
    column: int

    def to_dict(self) -> dict[str, object]:
        return {
            "rule_id": self.rule_id,
            "category": self.category,
            "severity": self.severity,
            "blocking": self.blocking,
            "field": self.field,
            "line": self.line,
            "column": self.column,
        }


@dataclass(frozen=True)
class PackageScanReport:
    """Sanitised report suitable for the publisher and server audit log."""

    scanner_version: str
    findings: tuple[PackageScanFinding, ...]

    @property
    def has_findings(self) -> bool:
        return bool(self.findings)

    @property
    def should_block(self) -> bool:
        return any(finding.blocking for finding in self.findings)

    def to_dict(self) -> dict[str, object]:
        return {
            "scanner_version": self.scanner_version,
            "has_findings": self.has_findings,
            "should_block": self.should_block,
            "findings": [finding.to_dict() for finding in self.findings],
        }


class PackageContentBlockedError(ValueError):
    """Raised when a package contains a secret or strong PII finding."""

    def __init__(self, report: PackageScanReport):
        self.report = report
        labels = sorted(
            {
                f"{finding.rule_id} at {finding.field}:{finding.line}"
                for finding in report.findings
                if finding.blocking
            }
        )
        super().__init__(
            "package content blocked by privacy scan: " + ", ".join(labels)
        )


_CARD_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9_])"
)
_UUID_RE = re.compile(
    r"(?i)(?<![0-9a-f])"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"(?![0-9a-f])"
)
_CN_ID_RE = re.compile(r"(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])")
_CN_PHONE_RE = re.compile(r"(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)")
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![A-Za-z0-9.-])"
)

_CN_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_CN_ID_CHECK_CODES = "10X98765432"

_PORTABLE_SECRET_PATTERNS = [
    LeakPattern(
        "openai_api_key_extended",
        r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "google_api_key",
        r"\bAIza[0-9A-Za-z_-]{30,}\b",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "jwt",
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        LeakSeverity.HIGH,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "credential_url",
        r"(?i:\b[a-z][a-z0-9+.-]*://)[^\s/:@]{1,128}:[^\s/@]{1,256}@",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "github_token_extended",
        r"\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "aws_access_key_extended",
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "bearer_token_case_insensitive",
        r"(?i:\bbearer)\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b",
        LeakSeverity.HIGH,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "aws_secret_access_key",
        r"(?i:(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key))\s*[=:]\s*[\"']?[A-Za-z0-9/+=]{40}",
        LeakSeverity.CRITICAL,
        LeakAction.BLOCK,
    ),
    LeakPattern(
        "credential_assignment_case_insensitive",
        r"(?i:\b(?:api[_ -]?key|apikey|api[_ -]?secret|access[_ -]?token|client[_ -]?secret|password|passwd|pwd))\s*[=:]\s*[\"']?[^\s\"']{8,}",
        LeakSeverity.HIGH,
        LeakAction.BLOCK,
    ),
]


def _line_column(text: str, offset: int) -> tuple[int, int]:
    line = text.count("\n", 0, offset) + 1
    last_newline = text.rfind("\n", 0, offset)
    column = offset + 1 if last_newline < 0 else offset - last_newline
    return line, column


def _passes_luhn(candidate: str) -> bool:
    digits = [int(char) for char in candidate if char.isdigit()]
    if not 13 <= len(digits) <= 19 or len(set(digits)) == 1:
        return False
    total = 0
    parity = len(digits) % 2
    for index, digit in enumerate(digits):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def _valid_cn_id(candidate: str) -> bool:
    normalized = candidate.upper()
    if len(normalized) != 18 or not normalized[:17].isdigit():
        return False
    if normalized[:6] == "000000":
        return False
    try:
        year = int(normalized[6:10])
        month = int(normalized[10:12])
        day = int(normalized[12:14])
        born = date(year, month, day)
    except ValueError:
        return False
    if born > date.today() or year < 1900:
        return False
    checksum = sum(
        int(char) * weight
        for char, weight in zip(normalized[:17], _CN_ID_WEIGHTS)
    )
    return normalized[-1] == _CN_ID_CHECK_CODES[checksum % 11]


def _finding(
    *,
    rule_id: str,
    category: str,
    severity: str,
    blocking: bool,
    field: str,
    text: str,
    offset: int,
) -> PackageScanFinding:
    line, column = _line_column(text, offset)
    return PackageScanFinding(
        rule_id=rule_id,
        category=category,
        severity=severity,
        blocking=blocking,
        field=field,
        line=line,
        column=column,
    )


class PackageScanner:
    """Scan selected package text fields for secrets and obvious PII."""

    def __init__(self, *, leak_detector: LeakDetector | None = None) -> None:
        self._leak_detector = leak_detector or LeakDetector(
            extra_patterns=_PORTABLE_SECRET_PATTERNS
        )

    def scan_fields(self, fields: Mapping[str, str]) -> PackageScanReport:
        blocking_findings: list[PackageScanFinding] = []
        review_findings: list[PackageScanFinding] = []
        for field, text in fields.items():
            if not text:
                continue
            for finding in self._scan_secrets(field, text):
                target = blocking_findings if finding.blocking else review_findings
                if len(target) < MAX_SCAN_FINDINGS:
                    target.append(finding)
            for finding in self._scan_pii(field, text):
                target = blocking_findings if finding.blocking else review_findings
                if len(target) < MAX_SCAN_FINDINGS:
                    target.append(finding)
            if len(blocking_findings) >= MAX_SCAN_FINDINGS:
                break

        findings = (blocking_findings + review_findings)[:MAX_SCAN_FINDINGS]
        findings.sort(
            key=lambda finding: (
                finding.field,
                finding.line,
                finding.column,
                finding.rule_id,
            )
        )
        return PackageScanReport(
            scanner_version=SCANNER_VERSION,
            findings=tuple(findings),
        )

    def scan_and_block(self, fields: Mapping[str, str]) -> PackageScanReport:
        report = self.scan_fields(fields)
        if report.should_block:
            raise PackageContentBlockedError(report)
        return report

    def _scan_secrets(self, field: str, text: str) -> Sequence[PackageScanFinding]:
        findings: list[PackageScanFinding] = []
        patterns = sorted(
            self._leak_detector.patterns,
            key=lambda pattern: pattern.name == "high_entropy_hex",
        )
        for pattern in patterns:
            for match in pattern.regex.finditer(text):
                # A bare high-entropy hash is useful as a review hint but commonly
                # appears in technical documentation. Named credentials and every
                # other detector match are blocked for package publication.
                blocking = pattern.name != "high_entropy_hex"
                findings.append(
                    _finding(
                        rule_id=f"secret.{pattern.name}",
                        category="secret",
                        severity=pattern.severity.value,
                        blocking=blocking,
                        field=field,
                        text=text,
                        offset=match.start(),
                    )
                )
                if len(findings) >= MAX_SCAN_FINDINGS:
                    return findings
        return findings

    def _scan_pii(self, field: str, text: str) -> Sequence[PackageScanFinding]:
        findings: list[PackageScanFinding] = []
        uuid_spans = tuple(match.span() for match in _UUID_RE.finditer(text))
        for match in _CARD_CANDIDATE_RE.finditer(text):
            if any(
                match.start() < end and start < match.end()
                for start, end in uuid_spans
            ):
                continue
            if _passes_luhn(match.group(0)):
                findings.append(
                    _finding(
                        rule_id="pii.payment_card",
                        category="pii",
                        severity="critical",
                        blocking=True,
                        field=field,
                        text=text,
                        offset=match.start(),
                    )
                )
                if len(findings) >= MAX_SCAN_FINDINGS:
                    return findings
        for match in _CN_ID_RE.finditer(text):
            if _valid_cn_id(match.group(0)):
                findings.append(
                    _finding(
                        rule_id="pii.cn_identity_number",
                        category="pii",
                        severity="critical",
                        blocking=True,
                        field=field,
                        text=text,
                        offset=match.start(),
                    )
                )
                if len(findings) >= MAX_SCAN_FINDINGS:
                    return findings
        for match in _CN_PHONE_RE.finditer(text):
            findings.append(
                _finding(
                    rule_id="pii.cn_phone",
                    category="pii",
                    severity="medium",
                    blocking=False,
                    field=field,
                    text=text,
                    offset=match.start(),
                )
            )
            if len(findings) >= MAX_SCAN_FINDINGS:
                return findings
        for match in _EMAIL_RE.finditer(text):
            findings.append(
                _finding(
                    rule_id="pii.email",
                    category="pii",
                    severity="medium",
                    blocking=False,
                    field=field,
                    text=text,
                    offset=match.start(),
                )
            )
            if len(findings) >= MAX_SCAN_FINDINGS:
                return findings
        return findings


__all__ = [
    "PackageContentBlockedError",
    "PackageScanFinding",
    "PackageScanReport",
    "PackageScanner",
    "MAX_SCAN_FINDINGS",
    "SCANNER_VERSION",
]
