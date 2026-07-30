"""Abbrivio's OTLP-native instrumentation and quality sidecars."""

from abbrivio.capture import (
    AbbrivioCompletionObserver,
    ExportedSpanRef,
    SpanIdentity,
    trace_id_for_interaction,
)
from abbrivio.cost import CostEstimate, ModelPrice, PriceCatalog
from abbrivio.deepeval import export_deepeval_summary, load_evaluation_cases
from abbrivio.sidecars import (
    ContentRecord,
    EvaluationCase,
    EvaluationRun,
    FeedbackEvent,
    SidecarStore,
    TraceRef,
    utc_now,
)

__version__ = "0.1.0"
CONTRACT_VERSION = "1"

__all__ = [
    "AbbrivioCompletionObserver",
    "CONTRACT_VERSION",
    "ContentRecord",
    "CostEstimate",
    "EvaluationCase",
    "EvaluationRun",
    "ExportedSpanRef",
    "FeedbackEvent",
    "ModelPrice",
    "PriceCatalog",
    "SidecarStore",
    "SpanIdentity",
    "TraceRef",
    "export_deepeval_summary",
    "load_evaluation_cases",
    "trace_id_for_interaction",
    "utc_now",
    "__version__",
]
