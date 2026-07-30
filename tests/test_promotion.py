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


@pytest.mark.parametrize("operator", ["eq", "in"])
def test_policy_does_not_coerce_numbers_to_booleans(operator):
    expected = True if operator == "eq" else [True]
    policy = AttributePromotionPolicy.from_dict(
        {"rules": [{"path": "value", "operator": operator, "value": expected}]}
    )

    assert policy.evaluate({"value": True}).allowed
    assert not policy.evaluate({"value": 1}).allowed
    assert not policy.evaluate({"value": 1.0}).allowed


def test_not_in_policy_does_not_coerce_numbers_to_booleans():
    policy = AttributePromotionPolicy.from_dict(
        {"rules": [{"path": "value", "operator": "not_in", "value": [True]}]}
    )

    assert not policy.evaluate({"value": True}).allowed
    assert policy.evaluate({"value": 1}).allowed


@pytest.mark.parametrize(
    ("expected", "coerced"),
    [
        ([True], [1]),
        ({"enabled": True}, {"enabled": 1}),
        ([{"enabled": True}], [{"enabled": 1}]),
    ],
)
def test_policy_equality_is_type_strict_inside_structures(expected, coerced):
    policy = AttributePromotionPolicy.from_dict(
        {"rules": [{"path": "value", "operator": "eq", "value": expected}]}
    )

    assert policy.evaluate({"value": expected}).allowed
    assert not policy.evaluate({"value": coerced}).allowed
