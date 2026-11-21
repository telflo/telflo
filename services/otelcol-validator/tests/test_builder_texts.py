"""`builder_texts.py`'s texts are still the web corpus's files. Run from
the repository; the image carries only this service, so there the check is
skipped (the binary tests use the copies)."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.builder_texts import COMPLEX_CONFIG, FORWARD_CONNECTOR

CORPUS = Path(__file__).resolve().parents[3] / "telflo-core" / "apps" / "web" / "app" / "lib" / "graph" / "corpus"


@pytest.mark.parametrize(("name", "text"), [("complex-config.yaml", COMPLEX_CONFIG), ("forward-connector.yaml", FORWARD_CONNECTOR)])
def test_a_builder_text_is_the_corpus_file(name: str, text: str) -> None:
    if not CORPUS.is_dir():
        pytest.skip("the web's corpus isn't beside this service (the image)")
    assert text == (CORPUS / name).read_text(encoding="utf-8")
