"""FastAPI application: routes, shared-secret auth, error handling.

The engine trusts exactly one caller — the NestJS control plane — over a shared
secret on a loopback or private-network hop. There is no per-tenant auth here on
purpose: tenancy is the control plane's job, and duplicating it would create two
places for an isolation bug to live.

Every route is defensive in the same way. A malformed request is a 422 from
pydantic; anything that goes wrong *during* analysis becomes a degraded response
with warnings, not a 500, because the caller has a queue behind it and a 500 is
a retry storm.
"""

from __future__ import annotations

import platform
import time
from collections.abc import Callable
from typing import Any

import orjson
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from . import ENGINE_VERSION, PIPELINE_VERSION
from .assemble import assemble
from .cache import get_cache
from .config import Settings, get_settings
from .embeddings import build_embedding_provider
from .extract import extract_rules
from .induce import induce_rules
from .llm.factory import provider_status
from .logging import bind_request, clear_request, configure_logging, get_logger
from .models import (
    AnalyzeRequest,
    AnalyzeResponse,
    AnalyzerHealth,
    AssembleRequest,
    EmbedRequest,
    EmbedResponse,
    EngineHealth,
    ExtractRulesRequest,
    InduceRulesRequest,
    PredictRequest,
    ProviderHealth,
    VersionResponse,
)
from .ocr import build_ocr_driver
from .pipeline import run_analysis
from .predict import predict
from .registry import ANALYZERS, registered_names

log = get_logger(__name__)


class ORJSONResponse(JSONResponse):
    """orjson is materially faster on the large `measurements` payloads and
    serialises numpy scalars, which turn up in evidence dicts."""

    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS)


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    configure_logging(s.log_level, json_output=s.node_env != "development")

    app = FastAPI(
        title="BrandLens Analysis Engine",
        version=ENGINE_VERSION,
        description="Measurement and judgment for brand compliance. Stateless by design.",
        default_response_class=ORJSONResponse,
    )

    # -- auth ---------------------------------------------------------------
    def require_secret(x_engine_secret: str | None = Header(default=None)) -> None:
        expected = s.engine_shared_secret
        if not expected:
            # Failing closed is right: an engine with no secret would accept
            # analysis requests from anything that can reach the port.
            raise HTTPException(status_code=503, detail="ENGINE_SHARED_SECRET is not configured")
        if not x_engine_secret or not _constant_time_eq(x_engine_secret, expected):
            raise HTTPException(status_code=401, detail="invalid or missing X-Engine-Secret")

    guard: list[Any] = [Depends(require_secret)]

    # -- middleware ---------------------------------------------------------
    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable) -> Response:
        started = time.perf_counter()
        request_id = request.headers.get("x-request-id") or f"req-{int(started * 1000)}"
        bind_request(request_id, path=request.url.path, method=request.method)
        try:
            response = await call_next(request)
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the worker
            log.exception("unhandled_request_error", path=request.url.path)
            clear_request()
            return ORJSONResponse(
                status_code=500,
                content={
                    "statusCode": 500,
                    "error": "InternalServerError",
                    "message": f"{type(exc).__name__}: {exc}",
                    "correlationId": request_id,
                },
            )
        duration = round((time.perf_counter() - started) * 1000.0, 2)
        response.headers["x-request-id"] = request_id
        response.headers["x-engine-version"] = ENGINE_VERSION
        response.headers["x-duration-ms"] = str(duration)
        if request.url.path not in ("/health", "/version"):
            log.info("request_complete", status=response.status_code, duration_ms=duration)
        clear_request()
        return response

    # -- analysis -----------------------------------------------------------
    @app.post("/v1/analyze", response_model=None, dependencies=guard)
    def analyze(request: AnalyzeRequest) -> ORJSONResponse:
        response: AnalyzeResponse = run_analysis(request, s)
        return ORJSONResponse(content=response.model_dump(by_alias=True, mode="json"))

    @app.post("/v1/extract-rules", response_model=None, dependencies=guard)
    def extract(request: ExtractRulesRequest) -> ORJSONResponse:
        result = extract_rules(request, s)
        return ORJSONResponse(content=result.model_dump(by_alias=True, mode="json"))

    @app.post("/v1/induce-rules", response_model=None, dependencies=guard)
    def induce(request: InduceRulesRequest) -> ORJSONResponse:
        result = induce_rules(request, s)
        return ORJSONResponse(content=result.model_dump(by_alias=True, mode="json"))

    @app.post("/v1/assemble", response_model=None, dependencies=guard)
    def assemble_route(request: AssembleRequest) -> ORJSONResponse:
        result = assemble(request, s)
        return ORJSONResponse(content=result.model_dump(by_alias=True, mode="json"))

    @app.post("/v1/predict", response_model=None, dependencies=guard)
    def predict_route(request: PredictRequest) -> ORJSONResponse:
        result = predict(request, s)
        return ORJSONResponse(content=result.model_dump(by_alias=True, mode="json"))

    @app.post("/v1/embed", response_model=None, dependencies=guard)
    def embed(request: EmbedRequest) -> ORJSONResponse:
        provider = build_embedding_provider(s, kind=request.kind)
        if request.kind == "image":
            result = provider.embed_images(request.image_uris)
        else:
            result = provider.embed_texts(request.texts)
        payload = EmbedResponse(
            request_id=request.request_id,
            provider=result.provider,
            dim=result.dim,
            vectors=result.vectors,
            cost_usd=result.cost_usd,
            warnings=list(result.warnings or []),
        )
        return ORJSONResponse(content=payload.model_dump(by_alias=True, mode="json"))

    # -- health -------------------------------------------------------------
    @app.get("/health", response_model=None)
    def health() -> ORJSONResponse:
        """Liveness only — deliberately unauthenticated and dependency-free so a
        load balancer can probe it without a secret and without touching disk."""
        return ORJSONResponse(content={"status": "ok", "engineVersion": ENGINE_VERSION})

    @app.get("/health/deep", response_model=None)
    def health_deep() -> ORJSONResponse:
        return ORJSONResponse(content=_deep_health(s).model_dump(by_alias=True, mode="json"))

    @app.get("/version", response_model=None)
    def version() -> ORJSONResponse:
        payload = VersionResponse(
            engine_version=ENGINE_VERSION,
            pipeline_version=PIPELINE_VERSION,
            python=platform.python_version(),
            analyzers=len(ANALYZERS),
        )
        return ORJSONResponse(content=payload.model_dump(by_alias=True, mode="json"))

    return app


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _deep_health(s: Settings) -> EngineHealth:
    """Probe every optional capability and report honestly.

    Half of a support ticket for this service is "why did every logo check come
    back insufficient_evidence", and the answer is almost always visible here.
    """
    warnings: list[str] = []
    analyzers: dict[str, AnalyzerHealth] = {}

    capabilities: dict[str, tuple[bool, str, str | None]] = {}
    for module, label in (
        ("cv2", "opencv"),
        ("fitz", "pymupdf"),
        ("pptx", "python-pptx"),
        ("skimage", "scikit-image"),
        ("sklearn", "scikit-learn"),
        ("scipy", "scipy"),
        ("imagehash", "imagehash"),
        ("textstat", "textstat"),
        ("rapidfuzz", "rapidfuzz"),
    ):
        try:
            mod = __import__("pymupdf" if module == "fitz" else module)
            capabilities[label] = (True, str(getattr(mod, "__version__", "unknown")), None)
        except Exception as exc:  # noqa: BLE001
            capabilities[label] = (False, "missing", str(exc)[:120])
            warnings.append(f"{label} unavailable: {exc}")

    needs = {
        "logo": ("opencv",),
        "color": ("scikit-image",),
        "typography": ("pymupdf", "rapidfuzz"),
        "layout": ("opencv",),
        "imagery": ("imagehash",),
        "copy": ("textstat", "rapidfuzz"),
        "accessibility": (),
        "channel_spec": (),
        "vlm": (),
    }
    for fn in registered_names():
        domain = fn.split(".")[0]
        required = needs.get(domain, ())
        missing = [r for r in required if not capabilities.get(r, (False, "", None))[0]]
        analyzers[fn] = AnalyzerHealth(
            available=not missing,
            version=ENGINE_VERSION,
            note=f"requires {', '.join(missing)}" if missing else None,
        )

    providers: dict[str, ProviderHealth] = {}
    for role, info in provider_status(s).items():
        providers[role] = ProviderHealth(configured=bool(info["configured"]), model=str(info.get("model") or ""))
        if not info["configured"]:
            warnings.append(f"LLM role {role!r} ({info['provider']}) has no credentials; T2 will abstain")

    ocr = build_ocr_driver(s)
    ocr_available = ocr.available()
    if not ocr_available:
        warnings.append(
            f"OCR driver {s.ocr_driver!r} is not usable; checks needing pixel text location will "
            "return insufficient_evidence"
        )

    try:
        s.ensure_dirs()
        probe = s.temp_dir / ".healthprobe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        scratch_ok = True
    except OSError as exc:
        scratch_ok = False
        warnings.append(f"scratch directory not writable ({s.temp_dir}): {exc}")

    if not s.engine_shared_secret:
        warnings.append("ENGINE_SHARED_SECRET is not set; all authenticated routes will return 503")

    cache = get_cache()
    status: str = "ok"
    if not scratch_ok or not s.engine_shared_secret or not capabilities.get("opencv", (False,))[0]:
        status = "error" if not s.engine_shared_secret else "degraded"
    elif warnings:
        status = "degraded"

    health = EngineHealth(
        status=status,  # type: ignore[arg-type]
        engine_version=ENGINE_VERSION,
        analyzers=analyzers,
        providers=providers,
        ocr_driver=f"{s.ocr_driver}{'' if ocr_available else ' (unavailable)'}",
        warnings=warnings,
    )
    health.analyzers["_capabilities"] = AnalyzerHealth(
        available=all(v[0] for v in capabilities.values()),
        version=ENGINE_VERSION,
        note="; ".join(f"{k}={v[1]}" for k, v in sorted(capabilities.items())),
    )
    health.analyzers["_cache"] = AnalyzerHealth(
        available=True,
        version=ENGINE_VERSION,
        note=f"memory={len(cache.memory)} entries, disk={'on' if cache.disk.enabled else 'off'}",
    )
    return health


app = create_app()


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    s = get_settings()
    uvicorn.run(
        "brandlens_engine.main:app",
        host=s.engine_host,
        port=s.engine_port,
        log_level=s.log_level.lower(),
        workers=1,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
