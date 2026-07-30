"""Append-only canonical OTLP JSONL trace storage."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections import defaultdict
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from abbrivio._file_lock import exclusive_file_lock
from abbrivio.otlp.codec import TraceData, decode_otlp_json, encode_otlp_json
from abbrivio.otlp.projection import project_requests

_INDEX_SCHEMA_VERSION = "1"
_PATH_LOCKS: dict[Path, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()
_IndexResult = TypeVar("_IndexResult")


def _lock_for_path(path: Path) -> threading.RLock:
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(path, threading.RLock())


def _sortable_nanos(value: int) -> str:
    return f"{value:020d}"


class OtlpJsonlStore:
    """Stores exactly one canonical OTLP export request per non-empty line."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.index_path = Path(f"{self.path}.index.sqlite3")
        self.lock_path = Path(f"{self.path}.lock")
        self._lock = _lock_for_path(self.path)

    @contextmanager
    def _locked(self) -> Iterator[None]:
        """Serialize canonical and index access across threads and processes."""
        with self._lock:
            with exclusive_file_lock(self.lock_path):
                yield

    def append(self, request: TraceData) -> None:
        payload = encode_otlp_json(request)
        indexed_request = decode_otlp_json(payload)
        encoded = (payload + "\n").encode("utf-8")
        with self._locked():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = self._open_ready_index()
            try:
                with self.path.open("ab") as handle:
                    offset = handle.tell()
                    try:
                        handle.write(encoded)
                        handle.flush()
                        os.fsync(handle.fileno())
                    except BaseException:
                        try:
                            handle.truncate(offset)
                            handle.flush()
                            os.fsync(handle.fileno())
                        except OSError:
                            pass
                        raise
                try:
                    with connection:
                        affected = self._index_request(
                            connection,
                            indexed_request,
                            line_offset=offset,
                            line_length=len(encoded),
                        )
                        self._replace_roots(connection, affected)
                        self._write_index_fingerprint(connection)
                except sqlite3.DatabaseError:
                    self._close_index(connection)
                    connection = None
                    self._discard_index()
                    rebuilt = self._open_ready_index()
                    self._close_index(rebuilt)
            finally:
                if connection is not None:
                    self._close_index(connection)

    def iter_requests(self) -> Iterator[ExportTraceServiceRequest]:
        if not self.path.exists():
            return
        with self._locked():
            self._recover_incomplete_tail()
            with self.path.open(encoding="utf-8") as handle:
                lines = list(handle)
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                yield decode_otlp_json(line)
            except Exception as error:
                raise ValueError(
                    f"invalid OTLP JSONL record at line {line_number}"
                ) from error

    def read_requests(self) -> list[ExportTraceServiceRequest]:
        return list(self.iter_requests())

    def combined_request(self) -> ExportTraceServiceRequest:
        combined = ExportTraceServiceRequest()
        for request in self.iter_requests():
            combined.resource_spans.extend(request.resource_spans)
        return combined

    def get_trace(self, trace_id: str) -> dict[str, Any] | None:
        normalized = trace_id.strip().lower()
        with self._locked():
            requests = self._run_index_operation(
                lambda connection: self._read_indexed_requests(connection, [normalized])
            )
        for trace in project_requests(requests):
            if trace.trace_id == normalized:
                return trace.to_dict()
        return None

    def trace_views(self, limit: int | None = None) -> list[dict[str, Any]]:
        """Return recent root views from a disposable index over canonical OTLP.

        The index only stores span locations and root ordering metadata. The views
        themselves are always reconstructed from the canonical OTLP JSONL records.
        """
        if limit is not None and limit < 0:
            raise ValueError("limit must be non-negative")
        if limit == 0:
            return []

        def read_views(
            connection: sqlite3.Connection,
        ) -> tuple[list[tuple[str, str]], list[ExportTraceServiceRequest]]:
            query = (
                "SELECT trace_id, root_span_id FROM trace_roots "
                "ORDER BY start_ns DESC, trace_id DESC, root_span_id DESC"
            )
            parameters: tuple[int, ...] = ()
            if limit is not None:
                query += " LIMIT ?"
                parameters = (limit,)
            selected_roots = list(connection.execute(query, parameters))
            trace_ids = list(dict.fromkeys(row[0] for row in selected_roots))
            return selected_roots, self._read_indexed_requests(connection, trace_ids)

        with self._locked():
            selected_roots, requests = self._run_index_operation(read_views)
        if not selected_roots:
            return []

        by_root = {
            (str(view["trace_id"]), str(view["root_span_id"] or "")): view
            for trace in project_requests(requests)
            for view in trace.root_views()
        }
        return [
            by_root[(trace_id, root_span_id)]
            for trace_id, root_span_id in selected_roots
        ]

    def _open_index(self) -> sqlite3.Connection:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.index_path)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS index_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS indexed_spans (
                    trace_id TEXT NOT NULL,
                    span_id TEXT NOT NULL,
                    parent_span_id TEXT,
                    start_ns TEXT NOT NULL,
                    end_ns TEXT NOT NULL,
                    line_offset INTEGER NOT NULL,
                    line_length INTEGER NOT NULL,
                    resource_index INTEGER NOT NULL,
                    scope_index INTEGER NOT NULL,
                    span_index INTEGER NOT NULL,
                    PRIMARY KEY (trace_id, span_id)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS indexed_spans_trace
                ON indexed_spans (trace_id)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS trace_roots (
                    trace_id TEXT NOT NULL,
                    root_span_id TEXT NOT NULL,
                    start_ns TEXT NOT NULL,
                    PRIMARY KEY (trace_id, root_span_id)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS trace_roots_recent
                ON trace_roots (start_ns DESC, trace_id DESC, root_span_id DESC)
                """
            )
            return connection
        except BaseException:
            if connection is not None:
                self._close_index(connection)
            raise

    @staticmethod
    def _close_index(connection: sqlite3.Connection) -> None:
        try:
            connection.close()
        except sqlite3.DatabaseError:
            pass

    def _discard_index(self) -> None:
        for path in (
            self.index_path,
            Path(f"{self.index_path}-wal"),
            Path(f"{self.index_path}-shm"),
            Path(f"{self.index_path}-journal"),
        ):
            path.unlink(missing_ok=True)

    def _open_ready_index(self) -> sqlite3.Connection:
        for attempt in range(2):
            connection: sqlite3.Connection | None = None
            try:
                connection = self._open_index()
                self._ensure_index(connection)
                return connection
            except BaseException as error:
                if connection is not None:
                    self._close_index(connection)
                if not isinstance(error, sqlite3.DatabaseError) or attempt > 0:
                    raise
                self._discard_index()
        raise AssertionError("unreachable")

    def _run_index_operation(
        self, operation: Callable[[sqlite3.Connection], _IndexResult]
    ) -> _IndexResult:
        for attempt in range(2):
            connection = self._open_ready_index()
            try:
                return operation(connection)
            except sqlite3.DatabaseError:
                if attempt > 0:
                    raise
            finally:
                self._close_index(connection)
            self._discard_index()
        raise AssertionError("unreachable")

    def _canonical_fingerprint(self) -> dict[str, str]:
        if not self.path.exists():
            return {
                "canonical_exists": "0",
                "canonical_size": "0",
                "canonical_mtime_ns": "0",
                "canonical_inode": "0",
            }
        stat = self.path.stat()
        return {
            "canonical_exists": "1",
            "canonical_size": str(stat.st_size),
            "canonical_mtime_ns": str(stat.st_mtime_ns),
            "canonical_inode": str(stat.st_ino),
        }

    def _metadata(self, connection: sqlite3.Connection) -> dict[str, str]:
        return dict(connection.execute("SELECT key, value FROM index_metadata"))

    def _write_index_fingerprint(self, connection: sqlite3.Connection) -> None:
        values = {
            "schema_version": _INDEX_SCHEMA_VERSION,
            **self._canonical_fingerprint(),
        }
        connection.executemany(
            """
            INSERT INTO index_metadata (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            values.items(),
        )

    def _ensure_index(self, connection: sqlite3.Connection) -> None:
        self._recover_incomplete_tail()
        expected = {
            "schema_version": _INDEX_SCHEMA_VERSION,
            **self._canonical_fingerprint(),
        }
        metadata = self._metadata(connection)
        if all(metadata.get(key) == value for key, value in expected.items()):
            return
        self._rebuild_index(connection)

    def _recover_incomplete_tail(self) -> None:
        """Repair the final record left by an interrupted append.

        A complete JSON object can reach durable storage before its delimiter. In
        that crash window the canonical OTLP record is valid and only needs a
        newline. An actually partial record is discarded back to the previous
        delimiter.
        """
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        with self.path.open("rb") as handle:
            handle.seek(-1, os.SEEK_END)
            if handle.read(1) == b"\n":
                return

            handle.seek(0, os.SEEK_END)
            cursor = handle.tell()
            last_newline = -1
            while cursor > 0 and last_newline < 0:
                start = max(0, cursor - 8192)
                handle.seek(start)
                chunk = handle.read(cursor - start)
                relative = chunk.rfind(b"\n")
                if relative >= 0:
                    last_newline = start + relative
                    break
                cursor = start

            tail_offset = last_newline + 1
            handle.seek(tail_offset)
            tail = handle.read()

        try:
            json.loads(tail)
        except (UnicodeDecodeError, json.JSONDecodeError):
            with self.path.open("r+b") as handle:
                handle.truncate(tail_offset)
                handle.flush()
                os.fsync(handle.fileno())
        else:
            try:
                with self.path.open("ab") as handle:
                    handle.write(b"\n")
                    handle.flush()
                    os.fsync(handle.fileno())
            except PermissionError:
                # A complete final record remains readable without mutating a
                # deliberately read-only canonical corpus.
                return

    def _rebuild_index(self, connection: sqlite3.Connection) -> None:
        affected: set[str] = set()
        with connection:
            connection.execute("DELETE FROM indexed_spans")
            connection.execute("DELETE FROM trace_roots")
            connection.execute("DELETE FROM index_metadata")
            if self.path.exists():
                with self.path.open("rb") as handle:
                    line_number = 0
                    while line := handle.readline():
                        line_number += 1
                        if not line.strip():
                            continue
                        offset = handle.tell() - len(line)
                        try:
                            request = decode_otlp_json(line)
                        except Exception as error:
                            raise ValueError(
                                f"invalid OTLP JSONL record at line {line_number}"
                            ) from error
                        affected.update(
                            self._index_request(
                                connection,
                                request,
                                line_offset=offset,
                                line_length=len(line),
                            )
                        )
            self._replace_roots(connection, affected)
            self._write_index_fingerprint(connection)

    def _index_request(
        self,
        connection: sqlite3.Connection,
        request: ExportTraceServiceRequest,
        *,
        line_offset: int,
        line_length: int,
    ) -> set[str]:
        affected: set[str] = set()
        for resource_index, resource_spans in enumerate(request.resource_spans):
            for scope_index, scope_spans in enumerate(resource_spans.scope_spans):
                for span_index, span in enumerate(scope_spans.spans):
                    trace_id = span.trace_id.hex()
                    affected.add(trace_id)
                    connection.execute(
                        """
                        INSERT INTO indexed_spans (
                            trace_id, span_id, parent_span_id, start_ns, end_ns,
                            line_offset, line_length, resource_index, scope_index,
                            span_index
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(trace_id, span_id) DO UPDATE SET
                            parent_span_id = excluded.parent_span_id,
                            start_ns = excluded.start_ns,
                            end_ns = excluded.end_ns,
                            line_offset = excluded.line_offset,
                            line_length = excluded.line_length,
                            resource_index = excluded.resource_index,
                            scope_index = excluded.scope_index,
                            span_index = excluded.span_index
                        """,
                        (
                            trace_id,
                            span.span_id.hex(),
                            span.parent_span_id.hex() if span.parent_span_id else None,
                            _sortable_nanos(int(span.start_time_unix_nano)),
                            _sortable_nanos(int(span.end_time_unix_nano)),
                            line_offset,
                            line_length,
                            resource_index,
                            scope_index,
                            span_index,
                        ),
                    )
        return affected

    def _replace_roots(
        self, connection: sqlite3.Connection, trace_ids: Sequence[str] | set[str]
    ) -> None:
        for trace_id in trace_ids:
            spans = list(
                connection.execute(
                    """
                    SELECT span_id, parent_span_id, start_ns
                    FROM indexed_spans WHERE trace_id = ?
                    """,
                    (trace_id,),
                )
            )
            known_ids = {row[0] for row in spans}
            roots = [
                (row[0], row[2])
                for row in spans
                if not row[1] or row[1] not in known_ids
            ]
            if not roots and spans:
                roots = [("", min(row[2] for row in spans))]
            connection.execute(
                "DELETE FROM trace_roots WHERE trace_id = ?", (trace_id,)
            )
            connection.executemany(
                """
                INSERT INTO trace_roots (trace_id, root_span_id, start_ns)
                VALUES (?, ?, ?)
                """,
                (
                    (trace_id, root_span_id, start_ns)
                    for root_span_id, start_ns in roots
                ),
            )

    def _read_indexed_requests(
        self, connection: sqlite3.Connection, trace_ids: Sequence[str]
    ) -> list[ExportTraceServiceRequest]:
        if not trace_ids or not self.path.exists():
            return []

        rows: list[tuple[Any, ...]] = []
        for offset in range(0, len(trace_ids), 500):
            chunk = trace_ids[offset : offset + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows.extend(
                connection.execute(
                    """
                    SELECT line_offset, line_length, resource_index, scope_index,
                           span_index
                    FROM indexed_spans
                    WHERE trace_id IN ("""
                    + placeholders
                    + ")",
                    tuple(chunk),
                )
            )

        locations: dict[int, list[tuple[int, int, int, int]]] = defaultdict(list)
        for line_offset, line_length, resource_index, scope_index, span_index in rows:
            locations[line_offset].append(
                (line_length, resource_index, scope_index, span_index)
            )

        selected = ExportTraceServiceRequest()
        with self.path.open("rb") as handle:
            for line_offset in sorted(locations):
                line_length = locations[line_offset][0][0]
                handle.seek(line_offset)
                request = decode_otlp_json(handle.read(line_length))
                for _, resource_index, scope_index, span_index in sorted(
                    locations[line_offset]
                ):
                    source_resource = request.resource_spans[resource_index]
                    source_scope = source_resource.scope_spans[scope_index]
                    target_resource = selected.resource_spans.add()
                    target_resource.resource.CopyFrom(source_resource.resource)
                    target_resource.schema_url = source_resource.schema_url
                    target_scope = target_resource.scope_spans.add()
                    target_scope.scope.CopyFrom(source_scope.scope)
                    target_scope.schema_url = source_scope.schema_url
                    target_scope.spans.add().CopyFrom(source_scope.spans[span_index])
        return [selected]
