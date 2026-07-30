import json

from abbrivio.cost import CostEstimate, PriceCatalog, is_versioned_model_alias


def test_catalog_prices_cached_and_regular_input_without_double_charging(tmp_path):
    path = tmp_path / "prices.json"
    path.write_text(
        json.dumps(
            {
                "version": "2026-07-30",
                "models": {
                    "model-a": {
                        "input_per_million": 2,
                        "cached_input_per_million": 1,
                        "output_per_million": 8,
                    }
                },
            }
        )
    )
    catalog = PriceCatalog.from_file(path)

    estimate = catalog.estimate(
        model="model-a",
        input_tokens=1_000,
        cached_input_tokens=200,
        output_tokens=250,
    )

    assert estimate.amount == 0.0038
    assert estimate.coverage == "priced"
    assert estimate.catalog_version == "2026-07-30"


def test_unknown_price_and_missing_usage_remain_distinct_from_zero():
    catalog = PriceCatalog.empty()

    unpriced = catalog.estimate(model="unknown", input_tokens=10, output_tokens=5)
    missing = catalog.estimate(model="unknown", input_tokens=10, output_tokens=None)

    assert unpriced.amount is None
    assert unpriced.coverage == "unpriced"
    assert missing.amount is None
    assert missing.coverage == "missing_usage"


def test_cost_span_attributes_are_flat_scalars_and_omit_unknown_amount():
    priced = CostEstimate(
        amount=0.12,
        source="catalog",
        catalog_version="v1",
        coverage="priced",
    ).span_attributes()
    unknown = CostEstimate(amount=None, coverage="unpriced").span_attributes()

    assert priced == {
        "abbrivio.cost.amount": 0.12,
        "abbrivio.cost.currency": "USD",
        "abbrivio.cost.source": "catalog",
        "abbrivio.cost.catalog.version": "v1",
        "abbrivio.cost.coverage": "priced",
    }
    assert "abbrivio.cost.amount" not in unknown
    assert all(isinstance(value, str | float) for value in priced.values())


def test_only_unambiguous_version_suffixes_use_requested_model_price():
    assert is_versioned_model_alias(requested="model-a", returned="model-a-2026-07-30")
    assert is_versioned_model_alias(requested="model-a", returned="model-a-v2.1")
    assert not is_versioned_model_alias(
        requested="model-a", returned="provider-model-b"
    )
    assert not is_versioned_model_alias(requested="gpt-4o", returned="gpt-4o-mini")
