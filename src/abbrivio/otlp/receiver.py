"""OTLP/HTTP FastAPI router for protobuf and JSON trace exports."""

from __future__ import annotations

import gzip
import io
import secrets
from typing import Protocol

from fastapi import APIRouter, HTTPException, Request, Response
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceResponse,
)
from starlette.concurrency import run_in_threadpool

from abbrivio.otlp.codec import decode_otlp_json, decode_otlp_protobuf

MAX_BODY_BYTES = 50 * 1024 * 1024


class TraceRequestSink(Protocol):
    def append(self, request: object) -> None: ...


def require_bearer_auth(request: Request, api_token: str | None) -> None:
    """Require a matching Bearer token when ingestion auth is configured."""

    if not api_token:
        return
    authorization = request.headers.get("authorization", "")
    scheme, separator, credential = authorization.partition(" ")
    matches = secrets.compare_digest(
        credential.encode("utf-8"),
        api_token.encode("utf-8"),
    )
    if scheme.lower() != "bearer" or not separator or not matches:
        raise HTTPException(
            status_code=401,
            detail="invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _gunzip_bounded(body: bytes, max_body_bytes: int) -> bytes:
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
            decoded = compressed.read(max_body_bytes + 1)
    except (EOFError, OSError) as error:
        raise ValueError("invalid gzip body") from error
    if len(decoded) > max_body_bytes:
        raise OverflowError("decompressed OTLP body is too large")
    return decoded


def _decode_body(
    body: bytes,
    *,
    content_type: str,
    content_encoding: str,
    max_body_bytes: int,
):
    if len(body) > max_body_bytes:
        raise OverflowError("OTLP body is too large")
    encoding = content_encoding.strip().lower()
    if encoding == "gzip":
        body = _gunzip_bounded(body, max_body_bytes)
    elif encoding not in {"", "identity"}:
        raise LookupError("unsupported content encoding")

    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "application/x-protobuf":
        return decode_otlp_protobuf(body), media_type
    if media_type == "application/json":
        return decode_otlp_json(body), media_type
    raise TypeError("unsupported OTLP content type")


def create_otlp_router(
    store: TraceRequestSink,
    *,
    max_body_bytes: int = MAX_BODY_BYTES,
    api_token: str | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/v1/traces")
    async def receive_traces(request: Request) -> Response:
        require_bearer_auth(request, api_token)
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
                raise HTTPException(status_code=413, detail="OTLP body is too large")

        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > max_body_bytes:
                raise HTTPException(status_code=413, detail="OTLP body is too large")
            body.extend(chunk)
        try:
            export_request, media_type = await run_in_threadpool(
                _decode_body,
                bytes(body),
                content_type=request.headers.get("content-type", ""),
                content_encoding=request.headers.get("content-encoding", ""),
                max_body_bytes=max_body_bytes,
            )
        except OverflowError as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except (TypeError, LookupError) as error:
            raise HTTPException(status_code=415, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(
                status_code=400,
                detail="invalid OTLP trace payload",
            ) from error

        try:
            await run_in_threadpool(store.append, export_request)
        except Exception as error:
            raise HTTPException(
                status_code=500,
                detail="OTLP trace storage failed",
            ) from error

        response = ExportTraceServiceResponse()
        if media_type == "application/json":
            return Response(content="{}", media_type="application/json")
        return Response(
            content=response.SerializeToString(),
            media_type="application/x-protobuf",
        )

    return router
