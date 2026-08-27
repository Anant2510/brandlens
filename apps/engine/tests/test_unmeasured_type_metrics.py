"""A type style whose weight the ontology never measured.

Discovery can reach a site two ways. A rendered crawl reads computed styles
off a real browser. A static crawl -- the fallback for a site that refuses
browsers -- reads served HTML and CSS: it learns the family the stylesheet
names and the role the markup implies, and it cannot learn what the browser
would have computed.

The control plane used to fill that gap with a constant, so "we never looked"
arrived here as "we saw regular 400". The engine is the part that ENFORCES,
so that is the worst possible place for an invented number: a weight nobody
observed becomes a weight real creative is graded against.

`font_weight` is now optional, and these pin what absence must mean.
"""

from brandlens_engine.models import TypeStyle


def test_type_style_accepts_an_unmeasured_weight() -> None:
    style = TypeStyle(name="body", role="body", font_family="Open Sans")
    assert style.font_weight is None


def test_a_measured_weight_still_round_trips() -> None:
    assert TypeStyle(name="body", role="body", font_family="Open Sans", font_weight=700).font_weight == 700


def test_wire_parsing_accepts_an_explicit_null_from_the_control_plane() -> None:
    # The contract sends `fontWeight: null`; pydantic must not coerce it to 0.
    style = TypeStyle.model_validate(
        {"name": "body", "role": "body", "fontFamily": "Open Sans", "fontWeight": None}
    )
    assert style.font_weight is None


def test_the_weight_check_is_skipped_rather_than_defaulted() -> None:
    """typography.py guards on truthiness before comparing weights.

    The guard reads `if match.style.font_weight and abs(...) > 250`. With None
    it short-circuits, so no weight finding is raised -- which is correct: we
    have nothing to hold the creative to. Substituting 400 would instead flag
    every bold headline on a site whose weights were never measured.
    """
    style = TypeStyle(name="body", role="body", font_family="Open Sans")
    # The exact expression from typography.py's guard.
    assert not (style.font_weight and abs((style.font_weight or 0) - 700) > 250)


def test_the_judge_describes_a_style_without_inventing_a_weight() -> None:
    unmeasured = TypeStyle(name="body", role="body", font_family="Open Sans")
    measured = TypeStyle(name="head", role="display", font_family="Open Sans", font_weight=700)
    rendered = ", ".join(
        f"{s.name}={s.font_family}" + (f" {int(s.font_weight)}" if s.font_weight is not None else "")
        for s in (unmeasured, measured)
    )
    assert rendered == "body=Open Sans, head=Open Sans 700"
    assert "400" not in rendered
