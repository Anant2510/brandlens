"""Extracts what every analyzer actually reads: parameters, and ontology.

WHY THIS EXISTS
---------------
A rule is authored in TypeScript and executed in Python. The bridge between
them is `check.params` — an untyped JSON blob. Nothing checks that the key a
rule writes is the key an analyzer reads, so a rule can name `maxGrade` while
the analyzer looks for `maxFleschKincaidGrade`, and the result is not an error:
the analyzer silently falls back to its default and the rule enforces nothing.
A threshold that appears in the UI, appears in the audit trail, and does
nothing is worse than a missing rule.

So the accepted keys are extracted from the Python source by AST — not from a
hand-maintained list, which would drift the first time somebody renamed a
parameter — and written to a manifest the TypeScript side asserts against.

The manifest also records two things the parameter list alone cannot say:

  * the DEFAULT each parameter falls back to, so a drift report can state what
    the engine would have enforced instead of what the rule claimed; and
  * which ONTOLOGY attributes the analyzer reads. Most checks take their
    expected values from the brand ontology (`ctx.brand.type_styles`,
    `ctx.brand.claims`) and use `params` only for tuning. A rule whose
    ontology dependency is unpopulated returns `not_applicable`, not `fail` —
    which is exactly what decides whether a rule can be shipped as a baseline
    that works on a brand with an empty ontology on day one.

Resolution follows module-local helper calls transitively. A first version did
not, and under-reported: `color.palette_conformance` reads `minShare` inside
`_observed_colors`, and an unfollowed helper means a missing key, which means
the guard waves a real typo through — the one failure it exists to prevent.

Run: python scripts/analyzer_params.py  (writes the manifest, prints a diff)
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

ENGINE_ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ENGINE_ROOT / "brandlens_engine"
MANIFEST = ENGINE_ROOT.parent.parent / "packages" / "contracts" / "src" / "analyzer-manifest.generated.ts"

#: Emitted as TypeScript rather than JSON on purpose. A JSON manifest would
#: need `resolveJsonModule` in every package that consumes contracts — the API,
#: the worker, the web app and the seed — and one of them forgetting it turns
#: the guard off silently. A `.ts` module is importable everywhere by default.
HEADER = """// GENERATED FILE — do not edit.
// Source: apps/engine/scripts/analyzer_params.py (run it after touching any analyzer)
//
// What each analyzer actually reads, extracted from the Python source by AST:
//   params    the `check.params` keys it looks up, and the default it falls
//             back to when the key is absent — which is what a rule silently
//             enforces instead of the threshold it displays.
//   ontology  the `ctx.brand.*` attributes it needs. A rule whose ontology
//             dependency is empty returns `not_applicable`, never `fail`.
//   asset     the `ctx.asset.*` fields it reads.

import type { AnalyzerContract, SpecKeyContract } from './analyzer-manifest.js';

export const GENERATED_ANALYZER_MANIFEST = {
"""

FOOTER = """} as const satisfies Record<string, AnalyzerContract>;
"""

SPEC_HEADER = """
// Every key `channel_spec.conformance` recognises, and what it does with it.
//
// The registry (packages/db/src/seed/data/channel-specs.ts) and the analyzer
// that consumes it are the same two-vocabularies problem as rules and their
// params, one level down: a spec key nobody reads is not an error, it is a
// published constraint that constrains nothing. They once shared three keys
// out of forty, which is how a blocker-severity rule came to check minimum
// dimensions and DPI while the safe zones, bleed and ink limits sat unread.
//
// roles:
//   enforced      channel_spec.conformance measures it
//   delegated     another analyzer measures it, automatically — `by` names it
//   authorable    `by` CAN measure it, but only if somebody writes that rule
//   unmeasurable  the engine cannot; `detail` says why
//   reference     not a constraint — other keys are expressed relative to it

export const GENERATED_SPEC_KEYS = {
"""

SPEC_FOOTER = """} as const satisfies Record<string, SpecKeyContract>;
"""

SPEC_ROLES = ("enforced", "delegated", "authorable", "unmeasurable", "reference")
_SPEC_FIELDS = ("role", "summary", "by", "detail")


def _literal(node: ast.AST) -> Any:
    """The node's value if it is a JSON-expressible literal, else None."""
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, (str, int, float, bool)) else None


class _Reads(ast.NodeVisitor):
    """Collects `params.get(...)`, `ctx.brand.X` and module-local calls."""

    def __init__(self) -> None:
        self.params: dict[str, Any] = {}
        self.ontology: set[str] = set()
        self.asset: set[str] = set()
        self.calls: set[str] = set()
        #: `params.get(<not a string literal>)` we could not resolve. Reported
        #: as a hard failure rather than skipped, because a key missing from
        #: the manifest reads as "no analyzer uses this" — so the guard would
        #: reject a rule that is in fact correct, and whoever hits that will
        #: "fix" a working rule.
        self.dynamic: set[str] = set()

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "get":
            # Deliberately broad: catches `params.get("x")`,
            # `rule.check.params.get("x")` and `(params.get("y") or {}).get("z")`
            # alike. A false positive costs a slightly permissive manifest; a
            # false negative would let a real typo through.
            if "params" in ast.unparse(func.value) and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    default = _literal(node.args[1]) if len(node.args) > 1 else None
                    # First default wins; a later `or 0.5` fallback is not the
                    # documented default and would misreport the contract.
                    self.params.setdefault(arg.value, default)
                else:
                    self.dynamic.add(ast.unparse(node))
        if isinstance(func, ast.Name) and func.id.startswith("_"):
            self.calls.add(func.id)
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:  # noqa: N802
        """Resolves the `for key, source in (("minHeightPx", params), ...)` idiom.

        `logo.check_min_size` looks its parameters up through a loop variable,
        so the literal names never appear as an argument to `.get`. Harvesting
        the string constants out of a tuple that also names `params` recovers
        them; the loop body's `source.get(key)` is separately recorded as
        dynamic, and both are reconciled in `_collect`.
        """
        source = ast.unparse(node.iter)
        if "params" in source:
            for child in ast.walk(node.iter):
                if isinstance(child, ast.Constant) and isinstance(child.value, str):
                    self.params.setdefault(child.value, None)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:  # noqa: N802
        source = ast.unparse(node)
        if source.startswith("ctx.brand."):
            self.ontology.add(source.split(".")[2])
        elif source.startswith("ctx.asset."):
            self.asset.add(source.split(".")[2])
        self.generic_visit(node)


def _module_functions() -> dict[str, dict[str, ast.FunctionDef]]:
    out: dict[str, dict[str, ast.FunctionDef]] = {}
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        out[path.stem] = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    return out


def _collect(module: str, name: str, functions: dict[str, dict[str, ast.FunctionDef]], seen: set[str]) -> _Reads:
    """Everything `module.name` reads, including via module-local helpers."""
    total = _Reads()
    key = f"{module}.{name}"
    if key in seen:
        return total
    seen.add(key)

    node = functions.get(module, {}).get(name)
    if node is None:
        return total

    reads = _Reads()
    reads.visit(node)
    total.params.update(reads.params)
    total.ontology |= reads.ontology
    total.asset |= reads.asset
    total.dynamic |= reads.dynamic

    for callee in sorted(reads.calls):
        nested = _collect(module, callee, functions, seen)
        for param, default in nested.params.items():
            total.params.setdefault(param, default)
        total.ontology |= nested.ontology
        total.asset |= nested.asset
        total.dynamic |= nested.dynamic

    # A dynamic lookup is forgiven only when the loop that drives it already
    # contributed the literal names — the `for key, source in (...)` idiom.
    # Anything else stays unresolved and fails the run.
    if total.params:
        total.dynamic = {d for d in total.dynamic if not _looks_resolved(d)}
    return total


def _looks_resolved(expression: str) -> bool:
    """True for `source.get(key)`-style lookups fed by a harvested tuple loop."""
    return bool(re.fullmatch(r"\w+\.get\(key(?:,\s*[^)]*)?\)", expression))


def _registry() -> dict[str, str]:
    """Maps analyzer name -> `module.function`, read from registry.py.

    Qualified by module because the bare names collide: `check_min_size` exists
    in BOTH logo.py and typography.py. Keying on the short name resolved every
    typography size rule to the logo analyzer and reported it as taking no
    parameters at all — a manifest that is confidently wrong is worse than none.
    """
    tree = ast.parse((PACKAGE / "registry.py").read_text(encoding="utf-8"))
    mapping: dict[str, str] = {}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values, strict=False):
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                continue
            # Entries look like: "logo.presence": logo.check_presence.
            for inner in ast.walk(value):
                if isinstance(inner, ast.Attribute) and inner.attr.startswith("check_"):
                    module = ast.unparse(inner.value).split(".")[-1]
                    mapping[key.value] = f"{module}.{inner.attr}"
    return mapping


def build() -> dict[str, dict[str, Any]]:
    functions = _module_functions()
    manifest: dict[str, dict[str, Any]] = {}
    unresolved: list[str] = []
    dynamic: list[str] = []

    for analyzer, qualified in sorted(_registry().items()):
        module, _, name = qualified.partition(".")
        if name not in functions.get(module, {}):
            unresolved.append(f"{analyzer} -> {qualified}")
            continue
        reads = _collect(module, name, functions, set())
        if reads.dynamic:
            dynamic.append(f"{analyzer} -> {qualified}: " + ", ".join(sorted(reads.dynamic)))
        manifest[analyzer] = {
            "fn": qualified,
            "params": {k: reads.params[k] for k in sorted(reads.params)},
            "ontology": sorted(reads.ontology),
            "asset": sorted(reads.asset),
        }

    if dynamic:
        # A parameter looked up through a variable never reaches the manifest,
        # so the guard would call a correct rule wrong. Better to fail here and
        # make somebody teach the extractor the new idiom.
        raise SystemExit("parameter names looked up dynamically:\n  " + "\n  ".join(dynamic))
    if unresolved:
        # Loud, not silent: an analyzer we cannot locate would be reported as
        # accepting no parameters, and every rule targeting it would then pass
        # the drift check while enforcing nothing.
        raise SystemExit("could not resolve analyzer functions:\n  " + "\n  ".join(unresolved))
    return manifest


def _spec_string(node: ast.AST, consts: dict[str, str]) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and node.id in consts:
        return consts[node.id]
    raise SystemExit(f"SPEC_KEYS: cannot resolve {ast.unparse(node)} to a string literal")


def spec_keys() -> dict[str, dict[str, str]]:
    """`SPEC_KEYS` from channel_spec.py, read as source rather than imported.

    Read by AST for the same reason the parameter manifest is: the alternative
    is a hand-maintained copy on the TypeScript side, and the first person to
    add a key to the analyzer without updating it turns the guard off silently.
    """
    tree = ast.parse((PACKAGE / "channel_spec.py").read_text(encoding="utf-8"))
    consts: dict[str, str] = {}
    node_value: ast.AST | None = None
    for node in tree.body:
        target: str | None = None
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target = node.target.id
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
        if target is None or node.value is None:
            continue
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            consts[target] = node.value.value
        if target == "SPEC_KEYS":
            node_value = node.value

    if not isinstance(node_value, ast.Dict):
        raise SystemExit("SPEC_KEYS is not a dict literal in channel_spec.py")

    keys: dict[str, dict[str, str]] = {}
    for key_node, value_node in zip(node_value.keys, node_value.values, strict=True):
        if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
            raise SystemExit(f"SPEC_KEYS: non-literal key {ast.unparse(key_node) if key_node else '?'}")
        if not isinstance(value_node, ast.Call):
            raise SystemExit(f"SPEC_KEYS[{key_node.value}] is not a SpecKey(...) call")
        entry = dict.fromkeys(_SPEC_FIELDS, "")
        for index, arg in enumerate(value_node.args):
            entry[_SPEC_FIELDS[index]] = _spec_string(arg, consts)
        for keyword in value_node.keywords:
            if keyword.arg not in _SPEC_FIELDS:
                raise SystemExit(f"SPEC_KEYS[{key_node.value}]: unknown field {keyword.arg!r}")
            entry[keyword.arg] = _spec_string(keyword.value, consts)

        if entry["role"] not in SPEC_ROLES:
            raise SystemExit(f"SPEC_KEYS[{key_node.value}]: role {entry['role']!r} is not one of {SPEC_ROLES}")
        if entry["role"] != "enforced" and not entry["detail"]:
            # Without one, the verdict says a constraint was not applied and
            # gives the reader nothing to do about it.
            raise SystemExit(f"SPEC_KEYS[{key_node.value}]: role {entry['role']!r} needs a `detail`")
        if entry["role"] in ("delegated", "authorable") and not entry["by"]:
            raise SystemExit(f"SPEC_KEYS[{key_node.value}]: role {entry['role']!r} needs a `by`")
        keys[key_node.value] = entry
    return keys


def _ts(value: Any) -> str:
    """A Python literal as its TypeScript equivalent."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return json.dumps(value)


def render(manifest: dict[str, dict[str, Any]], specs: dict[str, dict[str, str]]) -> str:
    lines: list[str] = [HEADER.rstrip("\n")]
    for analyzer, entry in sorted(manifest.items()):
        lines.append(f"  {json.dumps(analyzer)}: {{")
        lines.append(f"    fn: {json.dumps(entry['fn'])},")
        if entry["params"]:
            lines.append("    params: {")
            for name, default in entry["params"].items():
                lines.append(f"      {json.dumps(name)}: {_ts(default)},")
            lines.append("    },")
        else:
            lines.append("    params: {},")
        lines.append(f"    ontology: [{', '.join(json.dumps(o) for o in entry['ontology'])}],")
        lines.append(f"    asset: [{', '.join(json.dumps(a) for a in entry['asset'])}],")
        lines.append("  },")
    lines.append(FOOTER.rstrip("\n"))

    lines.append(SPEC_HEADER.rstrip("\n"))
    for key, entry in specs.items():
        fields = ", ".join(f"{name}: {json.dumps(entry[name])}" for name in _SPEC_FIELDS)
        lines.append(f"  {json.dumps(key)}: {{ {fields} }},")
    lines.append(SPEC_FOOTER.rstrip("\n"))
    return "\n".join(lines) + "\n"


def main() -> int:
    manifest = build()
    specs = spec_keys()
    payload = render(manifest, specs)

    previous = MANIFEST.read_text(encoding="utf-8") if MANIFEST.exists() else ""
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(payload, encoding="utf-8")

    covered = sum(1 for v in manifest.values() if v["params"])
    ontology_free = sorted(k for k, v in manifest.items() if not v["ontology"])
    print(f"analyzers: {len(manifest)}  with parameters: {covered}")
    print(f"need no ontology (usable on an empty brand): {len(ontology_free)}")
    for name in ontology_free:
        print(f"  - {name}")
    roles: dict[str, int] = {}
    for entry in specs.values():
        roles[entry["role"]] = roles.get(entry["role"], 0) + 1
    print("channel spec keys: " + ", ".join(f"{n} {r}" for r, n in sorted(roles.items())))
    print(f"manifest:  {MANIFEST}")
    if previous and previous != payload:
        print("CHANGED — commit the updated manifest.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
