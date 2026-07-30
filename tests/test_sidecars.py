import pytest

from abbrivio.sidecars import ContentRecord, SidecarStore, TraceRef, utc_now


def test_content_sidecar_joins_by_real_trace_and_span_ids(tmp_path):
    store = SidecarStore(tmp_path)
    first = ContentRecord(
        schema_version=1,
        content_id="content-1",
        recorded_at=utc_now(),
        trace=TraceRef(trace_id="1" * 32, span_id="2" * 16),
        input_text="first",
        output_text="draft",
    ).to_dict()
    latest = {
        **first,
        "recorded_at": utc_now(),
        "output_text": "final",
    }

    store.append("content", first)
    store.append("content", latest)

    assert store.find_content("1" * 32, "2" * 16)["output_text"] == "final"
    assert store.find_content("3" * 32) is None


def test_trace_refs_normalize_otlp_ids_to_lowercase():
    reference = TraceRef(trace_id="AB" * 16, span_id="CD" * 8)

    assert reference.trace_id == "ab" * 16
    assert reference.span_id == "cd" * 8


@pytest.mark.parametrize("sign", ["+", "-"])
def test_trace_refs_reject_signed_identifiers(sign):
    with pytest.raises(ValueError, match="hexadecimal"):
        TraceRef(trace_id=sign + "0" * 30 + "1")

    with pytest.raises(ValueError, match="hexadecimal"):
        TraceRef(trace_id="1" * 32, span_id=sign + "0" * 14 + "1")


def test_sidecar_store_does_not_filter_application_lifecycle_values(tmp_path):
    store = SidecarStore(tmp_path)
    for index, status in enumerate(
        ("generated", "failed", "scheduled", "anything_else"), start=1
    ):
        store.append(
            "content",
            {
                "content_id": status,
                "trace": {"trace_id": f"{index:032x}"},
                "attributes": {"example.lifecycle": status},
            },
        )

    assert [row["content_id"] for row in store.read("content")] == [
        "generated",
        "failed",
        "scheduled",
        "anything_else",
    ]
