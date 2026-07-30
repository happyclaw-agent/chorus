"""Extract evaluation fields from standard GenAI spans and linked sidecars."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class ExtractedEvaluation:
    input_text: str | None = None
    actual_output: str | None = None
    context: list[str] = field(default_factory=list)
    source_model: str | None = None
    source_agent_version: str | None = None


class ExtractionProfile(Protocol):
    profile_id: str

    def extract(
        self,
        trace: dict[str, Any],
        span: dict[str, Any] | None,
        content: dict[str, Any] | None,
    ) -> ExtractedEvaluation: ...


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return stripped
        extracted = _text(decoded)
        return extracted or stripped
    if isinstance(value, list):
        parts = [part for item in value if (part := _text(item))]
        return "\n".join(parts) or None
    if isinstance(value, dict):
        for key in ("content", "text", "message", "value"):
            if key in value and (result := _text(value[key])):
                return result
        parts = [part for item in value.values() if (part := _text(item))]
        return "\n".join(parts) or None
    return str(value)


class DefaultGenAIExtractionProfile:
    profile_id = "otel.gen_ai.v1"

    def extract(
        self,
        trace: dict[str, Any],
        span: dict[str, Any] | None,
        content: dict[str, Any] | None,
    ) -> ExtractedEvaluation:
        attributes = (span or {}).get("attributes") or {}
        content = content or {}
        input_text = None
        output_text = None
        for key in (
            "gen_ai.input.messages",
            "gen_ai.prompt",
            "gen_ai.input",
        ):
            if key in attributes and (input_text := _text(attributes[key])):
                break
        for key in (
            "gen_ai.output.messages",
            "gen_ai.completion",
            "gen_ai.output",
        ):
            if key in attributes and (output_text := _text(attributes[key])):
                break
        input_text = input_text or _text(content.get("input_text"))
        output_text = output_text or _text(content.get("output_text"))
        context = [str(value) for value in (content.get("context") or [])]
        resource_attributes = (
            ((span or {}).get("resource") or {}).get("attributes")
            or (span or {}).get("resource_attributes")
            or {}
        )
        source_agent_version = attributes.get(
            "gen_ai.agent.version"
        ) or resource_attributes.get("service.version")
        source_model = attributes.get("gen_ai.response.model") or attributes.get(
            "gen_ai.request.model"
        )
        return ExtractedEvaluation(
            input_text=input_text,
            actual_output=output_text,
            context=context,
            source_model=str(source_model) if source_model is not None else None,
            source_agent_version=(
                str(source_agent_version) if source_agent_version is not None else None
            ),
        )
