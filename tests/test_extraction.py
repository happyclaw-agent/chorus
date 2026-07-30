from chorus.extraction import DefaultGenAIExtractionProfile


def test_standard_genai_attributes_are_extracted():
    result = DefaultGenAIExtractionProfile().extract(
        {},
        {
            "attributes": {
                "gen_ai.input.messages": '[{"role":"user","content":"Help"}]',
                "gen_ai.output.messages": '[{"role":"assistant","content":"Here"}]',
                "gen_ai.response.model": "model-a",
            },
            "resource_attributes": {"service.version": "abc123"},
        },
        None,
    )

    assert result.input_text == "Help"
    assert result.actual_output == "Here"
    assert result.source_model == "model-a"
    assert result.source_agent_version == "abc123"


def test_linked_sidecar_fills_content_not_retained_on_span():
    result = DefaultGenAIExtractionProfile().extract(
        {},
        {"attributes": {}},
        {
            "input_text": "sidecar input",
            "output_text": "sidecar output",
            "context": ["account age: 2 days"],
        },
    )

    assert result.input_text == "sidecar input"
    assert result.actual_output == "sidecar output"
    assert result.context == ["account age: 2 days"]
