"""HTTP transport for generic Chorus sidecar records."""

from __future__ import annotations

import json
import math
from typing import Any
from urllib import error, parse, request

_MAX_ACK_RESPONSE_BYTES = 1024 * 1024
_MAX_ERROR_DETAIL_BYTES = 4096


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


class HttpSidecarWriter:
    """POST generic sidecar records to a Chorus server."""

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

    def append(self, collection: str, record: dict[str, Any]) -> dict[str, Any]:
        """Deliver one record and return the server's stored representation."""

        if not collection:
            raise ValueError("collection must not be empty")
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

        collection_path = parse.quote(collection, safe="")
        destination = f"{self.base_url}/api/sidecars/{collection_path}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self.bearer_token is not None:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        outbound = request.Request(
            destination,
            data=payload,
            headers=headers,
            method="POST",
        )

        try:
            with _open_without_redirects(outbound, timeout=self.timeout) as response:
                response_body, response_too_large = _read_bounded(
                    response,
                    limit=_MAX_ACK_RESPONSE_BYTES,
                )
        except error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise HttpSidecarError(
                    f"sidecar ingestion refused HTTP {exc.code} redirect"
                ) from exc
            detail_body, detail_truncated = _read_bounded(
                exc,
                limit=_MAX_ERROR_DETAIL_BYTES,
            )
            detail = detail_body.decode("utf-8", errors="replace").strip()
            if detail_truncated:
                detail = f"{detail} [truncated]"
            message = f"sidecar ingestion failed with HTTP {exc.code}"
            if detail:
                message = f"{message}: {detail}"
            raise HttpSidecarError(message) from exc
        except (error.URLError, TimeoutError, OSError) as exc:
            raise HttpSidecarError(f"sidecar ingestion failed: {exc}") from exc

        if response_too_large:
            raise HttpSidecarError("sidecar ingestion response exceeded size limit")

        try:
            result = json.loads(response_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HttpSidecarError("sidecar ingestion returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise HttpSidecarError("sidecar ingestion returned a non-object response")
        return result
