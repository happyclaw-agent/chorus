# Chorus and Abbrivio

Chorus is a local quality workspace for traces, feedback, evaluation cases, and
evaluation runs. Abbrivio is its instrumentation and interchange library.

OTLP is the trace contract. Chorus accepts OTLP/HTTP protobuf and JSON at
`POST /v1/traces`, stores one valid OTLP `TracesData` object per JSONL line,
and can export the corpus back to standard OTLP. Abbrivio extensions are legal
OpenTelemetry span attributes under `abbrivio.*`; application-specific
attributes use the application's own namespace.

Feedback, retained content, evaluation cases, evaluation catalogs, and
evaluation results are versioned JSONL sidecars linked by real trace and span
IDs. They never replace or reshape the OTLP trace data.

## Local use

```bash
python -m venv .venv
.venv/bin/pip install -e '.[test,otlp-http]'
.venv/bin/chorus --data-dir .chorus --port 8010
```

Configure any OpenTelemetry SDK to send OTLP/HTTP to
`http://127.0.0.1:8010/v1/traces`, then open
`http://127.0.0.1:8010`.

## Promotion

Manual trace-to-evaluation promotion is allowed by default. A configurable
promotion policy may deny a selection based on generic resource, scope, span,
or sidecar attribute paths. Chorus has no built-in concept of a customer,
delivery, workout, application lifecycle, or particular agent.

If retained input or output cannot be extracted, the promotion request may
supply it explicitly. Missing content is an extraction error, not a policy
decision.
