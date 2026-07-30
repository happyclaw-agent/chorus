"""Provider-neutral model pricing with explicit coverage semantics."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

CostCoverage = Literal["priced", "unpriced", "missing_usage"]


@dataclass(frozen=True, slots=True)
class CostEstimate:
    """A cost result that never turns missing information into zero cost."""

    amount: float | None
    currency: str = "USD"
    source: str = "unknown"
    catalog_version: str | None = None
    coverage: CostCoverage = "unpriced"

    def span_attributes(self) -> dict[str, str | float]:
        """Return scalar OpenTelemetry attributes under Abbrivio's namespace."""
        attributes: dict[str, str | float] = {
            "abbrivio.cost.currency": self.currency,
            "abbrivio.cost.source": self.source,
            "abbrivio.cost.coverage": self.coverage,
        }
        if self.amount is not None:
            attributes["abbrivio.cost.amount"] = self.amount
        if self.catalog_version is not None:
            attributes["abbrivio.cost.catalog.version"] = self.catalog_version
        return attributes


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input_per_million: float
    output_per_million: float
    cached_input_per_million: float | None = None

    def __post_init__(self) -> None:
        for name, value in (
            ("input_per_million", self.input_per_million),
            ("output_per_million", self.output_per_million),
            ("cached_input_per_million", self.cached_input_per_million),
        ):
            if value is None and name == "cached_input_per_million":
                continue
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise ValueError(f"{name} must be finite and non-negative")
            try:
                normalized = float(value)
            except (TypeError, ValueError, OverflowError):
                normalized = math.nan
            if not math.isfinite(normalized) or normalized < 0:
                raise ValueError(f"{name} must be finite and non-negative")
            object.__setattr__(self, name, normalized)


def is_versioned_model_alias(*, requested: str | None, returned: str | None) -> bool:
    """Whether a returned model only adds an unambiguous version suffix."""
    if not requested or not returned or requested == returned:
        return False
    return bool(
        re.fullmatch(
            rf"{re.escape(requested)}-(?:\d{{4}}-\d{{2}}-\d{{2}}|\d{{8}}|v\d+(?:\.\d+)*)",
            returned,
        )
    )


class PriceCatalog:
    """Versioned token pricing without provider or application dependencies."""

    def __init__(self, *, version: str, models: Mapping[str, ModelPrice]):
        self.version = version
        self.models = dict(models)

    @classmethod
    def empty(cls) -> PriceCatalog:
        return cls(version="none", models={})

    @classmethod
    def from_file(cls, path: str | Path | None) -> PriceCatalog:
        if not path:
            return cls.empty()
        raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
        models = {
            str(name): ModelPrice(
                input_per_million=values["input_per_million"],
                output_per_million=values["output_per_million"],
                cached_input_per_million=values.get("cached_input_per_million"),
            )
            for name, values in (raw.get("models") or {}).items()
        }
        return cls(version=str(raw.get("version") or "unknown"), models=models)

    def estimate(
        self,
        *,
        model: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        cached_input_tokens: int | None = None,
    ) -> CostEstimate:
        if input_tokens is None or output_tokens is None:
            return CostEstimate(amount=None, coverage="missing_usage")
        price = self.models.get(model or "")
        if price is None:
            return CostEstimate(
                amount=None,
                source="price_catalog",
                catalog_version=self.version,
                coverage="unpriced",
            )

        cached = min(max(cached_input_tokens or 0, 0), max(input_tokens, 0))
        regular_input = max(0, input_tokens - cached)
        cached_rate = (
            price.cached_input_per_million
            if price.cached_input_per_million is not None
            else price.input_per_million
        )
        amount = (
            regular_input * price.input_per_million
            + cached * cached_rate
            + max(output_tokens, 0) * price.output_per_million
        ) / 1_000_000
        return CostEstimate(
            amount=round(amount, 10),
            source="price_catalog",
            catalog_version=self.version,
            coverage="priced",
        )

    def estimate_completion(
        self,
        *,
        requested_model: str | None,
        returned_model: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        cached_input_tokens: int | None = None,
    ) -> CostEstimate:
        """Price the actual model, with a narrow alias-version fallback."""
        estimate = self.estimate(
            model=returned_model or requested_model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=cached_input_tokens,
        )
        if estimate.coverage == "unpriced" and is_versioned_model_alias(
            requested=requested_model,
            returned=returned_model,
        ):
            return self.estimate(
                model=requested_model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_input_tokens=cached_input_tokens,
            )
        return estimate
