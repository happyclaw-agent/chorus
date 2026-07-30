"""Generic, application-injected policies for manual trace promotion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class PromotionDecision:
    allowed: bool
    reason: str | None = None


class PromotionPolicy(Protocol):
    def evaluate(self, candidate: dict[str, Any]) -> PromotionDecision: ...


class AllowAllPromotionPolicy:
    def evaluate(self, candidate: dict[str, Any]) -> PromotionDecision:
        return PromotionDecision(allowed=True)


def _same_policy_value(actual: Any, expected: Any) -> bool:
    """Compare JSON-like values without Python's bool/number coercion."""
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, dict) or isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and isinstance(expected, dict)
            and actual.keys() == expected.keys()
            and all(_same_policy_value(actual[key], expected[key]) for key in actual)
        )
    if isinstance(actual, list) or isinstance(expected, list):
        return (
            isinstance(actual, list)
            and isinstance(expected, list)
            and len(actual) == len(expected)
            and all(
                _same_policy_value(actual_item, expected_item)
                for actual_item, expected_item in zip(actual, expected, strict=True)
            )
        )
    return actual == expected


def _resolve_path(value: Any, path: str) -> tuple[bool, Any]:
    current = value
    parts = path.split(".")
    for index, part in enumerate(parts):
        if not part:
            raise ValueError("promotion policy paths cannot contain empty segments")
        if not isinstance(current, dict):
            return False, None
        remainder = ".".join(parts[index:])
        if remainder in current:
            return True, current[remainder]
        if part not in current:
            return False, None
        current = current[part]
    return True, current


@dataclass(frozen=True, slots=True)
class AttributeRule:
    path: str
    operator: str
    value: Any = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> AttributeRule:
        path = str(value.get("path") or "").strip()
        operator = str(value.get("operator") or "").strip()
        if not path:
            raise ValueError("promotion policy rule requires a path")
        if operator not in {"exists", "eq", "in", "not_in"}:
            raise ValueError(f"unsupported promotion policy operator: {operator}")
        expected = value.get("value")
        if operator in {"in", "not_in"} and not isinstance(expected, list):
            raise ValueError(f"promotion policy operator {operator} requires a list")
        return cls(path=path, operator=operator, value=expected)

    def matches(self, candidate: dict[str, Any]) -> bool:
        exists, actual = _resolve_path(candidate, self.path)
        if self.operator == "exists":
            return exists is bool(self.value if self.value is not None else True)
        if not exists:
            return False
        if self.operator == "eq":
            return _same_policy_value(actual, self.value)
        if self.operator == "in":
            return any(_same_policy_value(actual, expected) for expected in self.value)
        return not any(_same_policy_value(actual, expected) for expected in self.value)


class AttributePromotionPolicy:
    """Allow only candidates satisfying every configured generic rule."""

    def __init__(self, rules: list[AttributeRule]):
        if not rules:
            raise ValueError("attribute promotion policy requires at least one rule")
        self.rules = tuple(rules)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> AttributePromotionPolicy:
        raw_rules = value.get("rules")
        if not isinstance(raw_rules, list):
            raise ValueError("promotion policy requires a rules list")
        return cls([AttributeRule.from_dict(rule) for rule in raw_rules])

    def evaluate(self, candidate: dict[str, Any]) -> PromotionDecision:
        for rule in self.rules:
            if not rule.matches(candidate):
                return PromotionDecision(
                    allowed=False,
                    reason=f"promotion policy rule did not match: {rule.path}",
                )
        return PromotionDecision(allowed=True)
