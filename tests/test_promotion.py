import pytest

from chorus.promotion import (
    AllowAllPromotionPolicy,
    AttributePromotionPolicy,
)


def test_default_policy_allows_any_candidate():
    assert AllowAllPromotionPolicy().evaluate({"span": {"status": "failed"}}).allowed


def test_attribute_policy_is_generic_and_reports_denial():
    policy = AttributePromotionPolicy.from_dict(
        {
            "rules": [
                {
                    "path": "span.attributes.example.reviewed",
                    "operator": "eq",
                    "value": True,
                }
            ]
        }
    )

    allowed = policy.evaluate({"span": {"attributes": {"example.reviewed": True}}})
    denied = policy.evaluate({"span": {"attributes": {"example.reviewed": False}}})

    assert allowed.allowed
    assert not denied.allowed
    assert "example.reviewed" in denied.reason


def test_invalid_policy_fails_during_configuration():
    with pytest.raises(ValueError, match="unsupported"):
        AttributePromotionPolicy.from_dict(
            {"rules": [{"path": "span.name", "operator": "contains"}]}
        )
