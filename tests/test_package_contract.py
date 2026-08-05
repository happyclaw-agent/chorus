import abbrivio
import chorus


def test_public_contract_version_is_explicit():
    assert abbrivio.CONTRACT_VERSION == "1"
    assert abbrivio.__version__ == "0.3.0"
    assert chorus.__version__ == "0.3.0"
    assert abbrivio.HttpSidecarWriter is not None
    assert abbrivio.HttpSidecarClient is not None
