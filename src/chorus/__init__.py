"""Chorus: a generic local quality workspace over canonical OTLP traces."""

from chorus.promotion import (
    AllowAllPromotionPolicy,
    AttributePromotionPolicy,
    AttributeRule,
    PromotionDecision,
    PromotionPolicy,
)

__version__ = "0.2.0"

__all__ = [
    "AllowAllPromotionPolicy",
    "AttributePromotionPolicy",
    "AttributeRule",
    "PromotionDecision",
    "PromotionPolicy",
    "__version__",
]
