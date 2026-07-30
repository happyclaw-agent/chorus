# Chorus and Abbrivio

Chorus is a local quality workspace for traces, feedback, evaluation cases, and
evaluation runs. Abbrivio is its instrumentation and interchange library.

OTLP is the trace contract. Chorus accepts OTLP/HTTP protobuf and JSON at
`POST /v1/traces`, stores one complete OTLP `ExportTraceServiceRequest` JSON
object per JSONL line, and can export the corpus back as a standard OTLP
request. The newline is only append-friendly file framing; every individual
record is the standard OTLP/HTTP trace payload rather than an Abbrivio trace
schema. Abbrivio extensions are legal OpenTelemetry span attributes under
`abbrivio.*`; application-specific attributes use the application's own
namespace.

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

For a process that cannot share the local filesystem, `HttpSidecarClient`
provides the same `append`, `read`, and `latest` operations as the local
sidecar store through `POST` and `GET /api/sidecars/{collection}`.
`HttpSidecarWriter` remains a compatible write-oriented name. Remote reads are
bounded to the newest 1,000 records; `latest` requests scan the complete
collection and either return a completeness-confirmed result under 8 MiB or
fail explicitly. Both paths refuse oversized responses and redirects. Set
`CHORUS_API_TOKEN` on the server and pass the same bearer token to OTLP and
sidecar clients when the server is reachable beyond localhost. When configured,
the token also protects trace, content, feedback, evaluation, export, and
promotion APIs; the browser UI prompts once and keeps the token only in session
storage. Mutation bodies are bounded to 1 MiB by default. The trace path remains
OTLP; the generic HTTP endpoint transports only the explicitly separate
sidecars.

```python
from abbrivio import HttpSidecarClient

sidecars = HttpSidecarClient(
    "https://chorus.example",
    bearer_token="replace-with-a-secret",
    timeout=2.0,
)
sidecars.append(
    "feedback",
    {
        "schema_version": 1,
        "kind": "helpful",
        "trace": {"trace_id": "0123456789abcdef0123456789abcdef"},
    },
)
latest_feedback = sidecars.latest("feedback", "feedback_id")
```

## Promotion

Manual trace-to-evaluation promotion is allowed by default. A configurable
promotion policy may deny a selection based on generic resource, scope, span,
or sidecar attribute paths. Chorus has no built-in concept of a customer,
delivery, workout, application lifecycle, or particular agent.

If retained input or output cannot be extracted, the promotion request may
supply it explicitly. Missing content is an extraction error, not a policy
decision.
