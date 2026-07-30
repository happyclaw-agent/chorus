"""HTTP transport for generic Chorus sidecar records."""

from __future__ import annotations

import json
import math
from typing import Any
from urllib import error, parse, request

_MAX_ACK_RESPONSE_BYTES = 1024 * 1024
MAX_SIDECAR_RESPONSE_BYTES = 8 * 1024 * 1024
_MAX_READ_RESPONSE_BYTES = MAX_SIDECAR_RESPONSE_BYTES
_MAX_ERROR_DETAIL_BYTES = 4096
MAX_SIDECAR_READ_LIMIT = 1000
_MAX_LATEST_KEY_LENGTH = 256


class HttpSidecarError(RuntimeError):
    """Raised when a sidecar record cannot be delivered or acknowledged."""


class _NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_without_redirects(outbound: request.Request, *, timeout: float):
    opener = request.build_opener(_NoRedirectHandler())
    return opener.open(outbound, timeout=timeout)


def _read_bounded(response: Any, *, limit: int) -> tuple[bytes, bool]:
    body = response.read(limit + 1)
    return body[:limit], len(body) > limit


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


class HttpSidecarClient:
    """Read and append generic sidecar records through the Chorus HTTP API."""

    def __init__(
        self,
        base_url: str,
        *,
        bearer_token: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        if not isinstance(base_url, str) or base_url != base_url.strip():
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        normalized_url = base_url.rstrip("/")
        if not normalized_url:
            raise ValueError("base_url must not be empty")
        try:
            parsed_url = parse.urlsplit(normalized_url)
            hostname = parsed_url.hostname
            _ = parsed_url.port
        except ValueError as exc:
            raise ValueError("base_url must be an absolute HTTP(S) URL") from exc
        if (
            parsed_url.scheme not in {"http", "https"}
            or not parsed_url.netloc
            or not hostname
            or any(character.isspace() for character in parsed_url.netloc)
        ):
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if parsed_url.username is not None or parsed_url.password is not None:
            raise ValueError("base_url must not contain credentials")
        if (
            parsed_url.query
            or parsed_url.fragment
            or "?" in normalized_url
            or "#" in normalized_url
        ):
            raise ValueError("base_url must not contain a query or fragment")
        try:
            configured_timeout = float(timeout)
        except (TypeError, ValueError) as exc:
            raise ValueError("timeout must be a finite positive number") from exc
        if not math.isfinite(configured_timeout) or configured_timeout <= 0:
            raise ValueError("timeout must be a finite positive number")
        self.base_url = normalized_url
        self.bearer_token = bearer_token or None
        self.timeout = configured_timeout

    def _headers(self, *, content_type: str | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if content_type is not None:
            headers["Content-Type"] = content_type
        if self.bearer_token is not None:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        return headers

    def _collection_url(self, collection: str) -> str:
        if not isinstance(collection, str) or not collection:
            raise ValueError("collection must not be empty")
        collection_path = parse.quote(collection, safe="")
        return f"{self.base_url}/api/sidecars/{collection_path}"

    def _send_json(
        self,
        outbound: request.Request,
        *,
        operation: str,
        response_limit: int,
    ) -> Any:
        try:
            with _open_without_redirects(outbound, timeout=self.timeout) as response:
                response_body, response_too_large = _read_bounded(
                    response,
                    limit=response_limit,
                )
        except error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise HttpSidecarError(
                    f"sidecar {operation} refused HTTP {exc.code} redirect"
                ) from exc
            detail_body, detail_truncated = _read_bounded(
                exc,
                limit=_MAX_ERROR_DETAIL_BYTES,
            )
            detail = detail_body.decode("utf-8", errors="replace").strip()
            if detail_truncated:
                detail = f"{detail} [truncated]"
            message = f"sidecar {operation} failed with HTTP {exc.code}"
            if detail:
                message = f"{message}: {detail}"
            raise HttpSidecarError(message) from exc
        except (error.URLError, TimeoutError, OSError) as exc:
            raise HttpSidecarError(f"sidecar {operation} failed: {exc}") from exc

        if response_too_large:
            raise HttpSidecarError(f"sidecar {operation} response exceeded size limit")

        try:
            return json.loads(response_body, parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HttpSidecarError(
                f"sidecar {operation} returned invalid JSON"
            ) from exc

    def append(self, collection: str, record: dict[str, Any]) -> dict[str, Any]:
        """Deliver one record and return the server's stored representation."""

        if not isinstance(record, dict):
            raise TypeError("record must be a JSON object")
        try:
            payload = json.dumps(
                record,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise ValueError("record must be JSON serializable") from exc

        outbound = request.Request(
            self._collection_url(collection),
            data=payload,
            headers=self._headers(content_type="application/json"),
            method="POST",
        )
        result = self._send_json(
            outbound,
            operation="ingestion",
            response_limit=_MAX_ACK_RESPONSE_BYTES,
        )
        if not isinstance(result, dict):
            raise HttpSidecarError("sidecar ingestion returned a non-object response")
        return result

    def read(
        self,
        collection: str,
        *,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Return a bounded, chronological slice of one sidecar collection."""

        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int):
                raise TypeError("limit must be an integer or None")
            if limit < 0:
                raise ValueError("limit must be non-negative")
            if limit > MAX_SIDECAR_READ_LIMIT:
                raise ValueError(
                    f"limit must be no greater than {MAX_SIDECAR_READ_LIMIT}"
                )
            if limit == 0:
                return []
        destination = self._collection_url(collection)
        if limit is not None:
            destination = f"{destination}?{parse.urlencode({'limit': limit})}"
        outbound = request.Request(
            destination,
            headers=self._headers(),
            method="GET",
        )
        result = self._send_json(
            outbound,
            operation="read",
            response_limit=_MAX_READ_RESPONSE_BYTES,
        )
        if not isinstance(result, list) or not all(
            isinstance(record, dict) for record in result
        ):
            raise HttpSidecarError(
                "sidecar read returned a non-list or non-object record"
            )
        if limit is not None and len(result) > limit:
            raise HttpSidecarError("sidecar read returned more records than requested")
        return result

    def latest(self, collection: str, key: str) -> list[dict[str, Any]]:
        """Return the latest record for every non-empty value of ``key``."""
        if not isinstance(key, str):
            raise TypeError("key must be a string")
        if not key or len(key) > _MAX_LATEST_KEY_LENGTH:
            raise ValueError(
                f"key must contain between 1 and {_MAX_LATEST_KEY_LENGTH} characters"
            )
        destination = self._collection_url(collection)
        destination = f"{destination}?{parse.urlencode({'latest_by': key})}"
        outbound = request.Request(
            destination,
            headers=self._headers(),
            method="GET",
        )
        result = self._send_json(
            outbound,
            operation="latest read",
            response_limit=MAX_SIDECAR_RESPONSE_BYTES,
        )
        if not isinstance(result, dict) or result.get("complete") is not True:
            raise HttpSidecarError(
                "sidecar latest read did not confirm a complete result"
            )
        if result.get("latest_by") != key:
            raise HttpSidecarError(
                "sidecar latest read did not confirm the requested key"
            )
        records = result.get("records")
        if not isinstance(records, list) or not all(
            isinstance(record, dict) for record in records
        ):
            raise HttpSidecarError(
                "sidecar latest read returned a non-list or non-object record"
            )
        return records


class HttpSidecarWriter(HttpSidecarClient):
    """Backward-compatible write-oriented name for :class:`HttpSidecarClient`."""
