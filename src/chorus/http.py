"""Shared HTTP request guards for Chorus API mutations."""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _decode_json_object(body: bytes) -> dict[str, Any]:
    value = json.loads(body, parse_constant=_reject_json_constant)
    if not isinstance(value, dict):
        raise TypeError("request body must be a JSON object")
    return value


async def _read_bounded_json_object(
    request: Request,
    *,
    max_body_bytes: int,
) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail="invalid content length",
            ) from error
        if declared_length < 0:
            raise HTTPException(status_code=400, detail="invalid content length")
        if declared_length > max_body_bytes:
            raise HTTPException(status_code=413, detail="JSON body is too large")

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > max_body_bytes:
            raise HTTPException(status_code=413, detail="JSON body is too large")
        body.extend(chunk)
    try:
        return await run_in_threadpool(_decode_json_object, bytes(body))
    except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=422,
            detail="request body must be a valid JSON object",
        ) from error


async def _bounded_json_object_dependency(request: Request) -> dict[str, Any]:
    return await _read_bounded_json_object(
        request,
        max_body_bytes=request.app.state.max_json_body_bytes,
    )


JsonObject = Annotated[
    dict[str, Any],
    Depends(_bounded_json_object_dependency),
]
