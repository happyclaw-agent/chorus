from __future__ import annotations

import json
import multiprocessing
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import abbrivio.sidecars.store as sidecar_store_module
from abbrivio.sidecars import (
    ContentRecord,
    SidecarResponseTooLarge,
    SidecarStore,
    TraceRef,
    utc_now,
)


def _append_sidecars_in_process(
    root: str, writer: str, count: int, payload_size: int
) -> None:
    store = SidecarStore(root)
    for index in range(count):
        store.append(
            "feedback",
            {
                "feedback_id": f"{writer}-{index}",
                "payload": writer * payload_size,
            },
        )


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


def test_root_linked_content_keeps_distinct_lookup_and_detail_entries(tmp_path):
    store = SidecarStore(tmp_path)
    trace_id = "1" * 32
    first_root = "2" * 16
    second_root = "3" * 16
    records = [
        {
            "content_id": "first-old",
            "trace": {"trace_id": trace_id, "root_span_id": first_root},
        },
        {
            "content_id": "second",
            "trace": {"trace_id": trace_id, "root_span_id": second_root},
        },
        {
            "content_id": "first-new",
            "trace": {"trace_id": trace_id, "root_span_id": first_root},
        },
        {
            "content_id": "trace-wide",
            "trace": {"trace_id": trace_id},
        },
    ]
    for record in records:
        store.append("content", record)

    assert store.find_content(trace_id, root_span_id=first_root)["content_id"] == (
        "first-new"
    )
    assert store.find_content(trace_id, root_span_id=second_root)["content_id"] == (
        "second"
    )
    assert store.find_content(trace_id)["content_id"] == "trace-wide"
    assert [record["content_id"] for record in store.content_for_trace(trace_id)] == [
        "first-new",
        "second",
        "trace-wide",
    ]


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


def test_sidecar_read_with_zero_limit_is_empty(tmp_path):
    store = SidecarStore(tmp_path)
    store.append("feedback", {"feedback_id": "feedback-1"})

    assert store.read("feedback", limit=0) == []


def test_sidecar_read_rejects_negative_limit(tmp_path):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match="non-negative"):
        store.read("feedback", limit=-1)
    with pytest.raises(TypeError, match="integer"):
        store.read("feedback", limit=1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="integer"):
        store.read("feedback", limit=True)


def test_sidecar_limited_read_scans_only_enough_tail_for_valid_objects(
    tmp_path, monkeypatch
):
    store = SidecarStore(tmp_path)
    path = store.path_for("feedback")
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {"feedback_id": f"feedback-{index}", "payload": "x" * 128}
        for index in range(1_001)
    ]
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )
    assert path.stat().st_size > sidecar_store_module._TAIL_READ_CHUNK_BYTES
    decoded_lines = 0
    original_loads = sidecar_store_module.json.loads

    def counting_loads(value):
        nonlocal decoded_lines
        decoded_lines += 1
        return original_loads(value)

    monkeypatch.setattr(sidecar_store_module.json, "loads", counting_loads)

    assert store.read("feedback", limit=1) == [records[-1]]
    assert decoded_lines == 1


def test_sidecar_limited_read_returns_newest_valid_objects_in_order(tmp_path):
    store = SidecarStore(tmp_path)
    path = store.path_for("feedback")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b'{"feedback_id":"first"}\n'
        b"not-json\n"
        b'{"feedback_id":"second"}\n'
        b"[]\n"
        b'{"feedback_id":"third"}'
    )

    assert store.read("feedback", limit=2) == [
        {"feedback_id": "second"},
        {"feedback_id": "third"},
    ]
    assert store.read("feedback", limit=0) == []


def test_bounded_sidecar_json_stops_decoding_when_newest_slice_exceeds_budget(
    tmp_path, monkeypatch
):
    store = SidecarStore(tmp_path)
    records = [
        {"feedback_id": f"feedback-{index}", "payload": "x" * 32}
        for index in range(100)
    ]
    path = store.path_for("feedback")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )
    newest_size = len(json.dumps(records[-1], separators=(",", ":")).encode("utf-8"))
    decoded_lines = 0
    original_loads = sidecar_store_module.json.loads

    def counting_loads(value):
        nonlocal decoded_lines
        decoded_lines += 1
        return original_loads(value)

    monkeypatch.setattr(sidecar_store_module.json, "loads", counting_loads)

    with pytest.raises(SidecarResponseTooLarge, match="exceeded size limit"):
        store.read_json_bounded(
            "feedback",
            limit=100,
            max_bytes=2 + newest_size,
        )

    assert decoded_lines == 2


def test_bounded_latest_json_stops_decoding_when_envelope_exceeds_budget(
    tmp_path, monkeypatch
):
    store = SidecarStore(tmp_path)
    key = "case_id"
    records = [
        {"case_id": f"case-{index}", "payload": "x" * 32} for index in range(100)
    ]
    path = store.path_for("eval_cases")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )
    empty_envelope_size = len(
        json.dumps(
            {"complete": True, "latest_by": key, "records": []},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    newest_size = len(json.dumps(records[-1], separators=(",", ":")).encode("utf-8"))
    decoded_lines = 0
    original_loads = sidecar_store_module.json.loads

    def counting_loads(value):
        nonlocal decoded_lines
        decoded_lines += 1
        return original_loads(value)

    monkeypatch.setattr(sidecar_store_module.json, "loads", counting_loads)

    with pytest.raises(SidecarResponseTooLarge, match="exceeded size limit"):
        store.latest_json_bounded(
            "eval_cases",
            key,
            max_bytes=empty_envelope_size + newest_size,
        )

    assert decoded_lines == 2


def test_sidecar_append_rejects_non_json_records(tmp_path):
    store = SidecarStore(tmp_path)

    with pytest.raises(TypeError, match="JSON object"):
        store.append("feedback", [])  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="JSON serializable"):
        store.append("feedback", {"value": float("nan")})

    assert not store.path_for("feedback").exists()


def test_sidecar_append_validates_and_normalizes_optional_trace_reference(tmp_path):
    store = SidecarStore(tmp_path)
    original = {
        "feedback_id": "linked",
        "trace": {
            "trace_id": "AB" * 16,
            "span_id": "CD" * 8,
            "root_span_id": "EF" * 8,
            "application_key": "preserved",
        },
        "application_field": {"anything": True},
    }

    stored = store.append("feedback", original)
    store.append("feedback", {"feedback_id": "unlinked"})
    store.append("feedback", {"feedback_id": "explicit-null", "trace": None})

    records = store.read("feedback")
    assert records[0]["trace"] == {
        "trace_id": "ab" * 16,
        "span_id": "cd" * 8,
        "root_span_id": "ef" * 8,
        "application_key": "preserved",
    }
    assert stored == records[0]
    assert records[0]["application_field"] == {"anything": True}
    assert original["trace"]["trace_id"] == "AB" * 16
    assert records[1:] == [
        {"feedback_id": "unlinked"},
        {"feedback_id": "explicit-null", "trace": None},
    ]


def test_sidecar_append_recovers_incomplete_tail_before_next_acknowledgement(
    tmp_path,
):
    store = SidecarStore(tmp_path)
    first = {"feedback_id": "first"}
    second = {"feedback_id": "second"}
    store.append("feedback", first)
    committed = store.path_for("feedback").read_bytes()
    with store.path_for("feedback").open("ab") as handle:
        handle.write(b'{"feedback_id":"interrupted"')

    assert store.append("feedback", second) == second

    assert store.path_for("feedback").read_bytes().startswith(committed)
    assert store.read("feedback") == [first, second]
    assert all(
        json.loads(line) in (first, second)
        for line in store.path_for("feedback").read_text().splitlines()
    )


@pytest.mark.parametrize(
    "existing",
    [
        {"feedback_id": "complete"},
        {"feedback_id": "future-link-format", "trace": "not-an-object-yet"},
    ],
    ids=["valid", "syntactically-complete-forward-format"],
)
def test_sidecar_append_preserves_complete_unterminated_record(tmp_path, existing):
    store = SidecarStore(tmp_path)
    path = store.path_for("feedback")
    path.parent.mkdir(parents=True, exist_ok=True)
    original = json.dumps(existing, separators=(",", ":")).encode("utf-8")
    path.write_bytes(original)
    following = {"feedback_id": "following"}

    store.append("feedback", following)

    assert path.read_bytes().startswith(original + b"\n")
    assert store.read("feedback") == [existing, following]


def test_sidecar_append_rolls_back_partial_write_after_recovering_crash_tail(
    tmp_path, monkeypatch
):
    store = SidecarStore(tmp_path)
    first = {"feedback_id": "first"}
    failed = {"feedback_id": "failed"}
    following = {"feedback_id": "following"}
    store.append("feedback", first)
    path = store.path_for("feedback")
    committed = path.read_bytes()
    with path.open("ab") as handle:
        handle.write(b'{"feedback_id":"prior-crash"')

    original_write_all = sidecar_store_module._write_all

    def fail_after_partial_write(handle, payload):
        handle.write(payload[: max(1, len(payload) // 2)])
        raise OSError("simulated partial sidecar write")

    monkeypatch.setattr(
        sidecar_store_module,
        "_write_all",
        fail_after_partial_write,
    )
    with pytest.raises(OSError, match="simulated partial sidecar write"):
        store.append("feedback", failed)

    assert path.read_bytes() == committed

    monkeypatch.setattr(sidecar_store_module, "_write_all", original_write_all)
    assert store.append("feedback", following) == following
    assert store.read("feedback") == [first, following]


def test_sidecar_append_rolls_back_when_fsync_fails(tmp_path, monkeypatch):
    store = SidecarStore(tmp_path)
    first = {"feedback_id": "first"}
    store.append("feedback", first)
    path = store.path_for("feedback")
    committed = path.read_bytes()
    original_fsync = sidecar_store_module.os.fsync
    calls = 0

    def fail_once(file_descriptor):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("simulated sidecar fsync failure")
        return original_fsync(file_descriptor)

    monkeypatch.setattr(sidecar_store_module.os, "fsync", fail_once)
    with pytest.raises(OSError, match="simulated sidecar fsync failure"):
        store.append("feedback", {"feedback_id": "failed"})

    assert path.read_bytes() == committed
    assert store.read("feedback") == [first]


@pytest.mark.parametrize("trace", ["not-an-object", [], 3])
def test_sidecar_append_rejects_non_object_trace(tmp_path, trace):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match="trace must be a JSON object or null"):
        store.append("feedback", {"trace": trace})


@pytest.mark.parametrize(
    "trace, message",
    [
        ({"trace_id": "1" * 31}, "32 hexadecimal"),
        ({"trace_id": "0" * 32}, "nonzero"),
        ({"trace_id": 123}, "hexadecimal string"),
        ({"span_id": "2" * 16}, "require trace_id"),
        ({"trace_id": "1" * 32, "span_id": "0" * 16}, "nonzero"),
        ({"trace_id": "1" * 32, "root_span_id": "Z" * 16}, "hexadecimal"),
    ],
)
def test_sidecar_append_rejects_invalid_trace_identifiers(tmp_path, trace, message):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match=message):
        store.append("feedback", {"trace": trace})

    assert not store.path_for("feedback").exists()


def test_sidecar_joins_skip_malformed_historical_trace_fields(tmp_path):
    store = SidecarStore(tmp_path)
    trace_id = "1" * 32
    span_id = "2" * 16
    malformed = [
        {"content_id": "string", "trace": "bad"},
        {"content_id": "list", "trace": []},
        {"content_id": "number", "trace": 3},
        {"content_id": "null", "trace": None},
        {"content_id": "numeric-id", "trace": {"trace_id": 123}},
    ]
    valid = {
        "content_id": "valid",
        "trace": {"trace_id": trace_id, "span_id": span_id},
        "output_text": "kept",
    }
    content_path = store.path_for("content")
    content_path.parent.mkdir(parents=True, exist_ok=True)
    content_path.write_text(
        "".join(json.dumps(record) + "\n" for record in [*malformed, valid]),
        encoding="utf-8",
    )
    feedback_path = store.path_for("feedback")
    feedback_path.write_text(
        "".join(
            json.dumps(record) + "\n"
            for record in [
                {"feedback_id": "bad", "trace": "bad"},
                {"feedback_id": "valid", "trace": {"trace_id": trace_id}},
            ]
        ),
        encoding="utf-8",
    )

    assert store.find_content(trace_id, span_id) == valid
    assert store.content_for_trace(trace_id) == [valid]
    assert store.feedback_for_trace(trace_id) == [
        {"feedback_id": "valid", "trace": {"trace_id": trace_id}}
    ]


def test_sidecar_store_serializes_threaded_writers_and_live_readers(tmp_path):
    writer_count = 6
    records_per_writer = 25
    gate = threading.Barrier(writer_count + 1)

    def append_records(writer: int) -> None:
        store = SidecarStore(tmp_path)
        gate.wait()
        for index in range(records_per_writer):
            store.append(
                "content",
                {
                    "content_id": f"thread-{writer}-{index}",
                    "payload": "x" * 2048,
                },
            )

    with ThreadPoolExecutor(max_workers=writer_count) as executor:
        futures = [executor.submit(append_records, writer) for writer in range(6)]
        gate.wait()
        reader = SidecarStore(tmp_path)
        while not all(future.done() for future in futures):
            assert all(
                record["content_id"].startswith("thread-")
                for record in reader.read("content")
            )
            time.sleep(0.001)
        for future in futures:
            future.result()

    records = SidecarStore(tmp_path).read("content")
    assert len(records) == writer_count * records_per_writer
    assert len({record["content_id"] for record in records}) == len(records)
    raw_lines = SidecarStore(tmp_path).path_for("content").read_text().splitlines()
    assert len(raw_lines) == len(records)
    assert [json.loads(line) for line in raw_lines] == records


def test_sidecar_store_serializes_spawned_processes_and_live_reader(tmp_path):
    context = multiprocessing.get_context("spawn")
    process_count = 3
    records_per_process = 20
    processes = [
        context.Process(
            target=_append_sidecars_in_process,
            args=(str(tmp_path), f"process-{index}", records_per_process, 1024),
        )
        for index in range(process_count)
    ]
    for process in processes:
        process.start()

    reader = SidecarStore(tmp_path)
    deadline = time.monotonic() + 30
    try:
        while any(process.is_alive() for process in processes):
            assert all(
                record["feedback_id"].startswith("process-")
                for record in reader.read("feedback")
            )
            if time.monotonic() >= deadline:
                pytest.fail("spawned sidecar writers did not finish in time")
            time.sleep(0.002)
        for process in processes:
            process.join(timeout=5)
            assert process.exitcode == 0
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)

    records = reader.read("feedback")
    assert len(records) == process_count * records_per_process
    assert len({record["feedback_id"] for record in records}) == len(records)
    raw_lines = Path(reader.path_for("feedback")).read_text().splitlines()
    assert len(raw_lines) == len(records)
    assert [json.loads(line) for line in raw_lines] == records
