"""Abbrivio's OTLP-native instrumentation and quality sidecars."""

from abbrivio.capture import (
    AbbrivioCompletionObserver,
    ExportedSpanRef,
    SpanIdentity,
    trace_id_for_interaction,
)
from abbrivio.cost import CostEstimate, ModelPrice, PriceCatalog
from abbrivio.deepeval import (
    export_deepeval_summary,
    export_evaluation_results,
    load_evaluation_cases,
    load_evaluation_results,
)
from abbrivio.sidecars import (
    MAX_SIDECAR_READ_LIMIT,
    ContentRecord,
    EvaluationCase,
    EvaluationResult,
    EvaluationRun,
    FeedbackEvent,
    HttpSidecarClient,
    HttpSidecarError,
    HttpSidecarWriter,
    SidecarStore,
    TraceRef,
    utc_now,
)

__version__ = "0.3.0"
CONTRACT_VERSION = "1"

__all__ = [
    "AbbrivioCompletionObserver",
    "CONTRACT_VERSION",
    "ContentRecord",
    "CostEstimate",
    "EvaluationCase",
    "EvaluationResult",
    "EvaluationRun",
    "ExportedSpanRef",
    "FeedbackEvent",
    "HttpSidecarClient",
    "HttpSidecarError",
    "HttpSidecarWriter",
    "MAX_SIDECAR_READ_LIMIT",
    "ModelPrice",
    "PriceCatalog",
    "SidecarStore",
    "SpanIdentity",
    "TraceRef",
    "export_deepeval_summary",
    "export_evaluation_results",
    "load_evaluation_cases",
    "load_evaluation_results",
    "trace_id_for_interaction",
    "utc_now",
    "__version__",
]
