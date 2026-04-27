import json
import os
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import embed, parser, rank, storage

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
storage.init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[cvstack] preloading embedding model…")
    embed.model()
    print("[cvstack] ready.")
    yield


app = FastAPI(title="cvstack", lifespan=lifespan)

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html", headers=NO_CACHE_HEADERS)


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/static/", "/api/")):
        for k, v in NO_CACHE_HEADERS.items():
            response.headers[k] = v
    return response


SUPPORTED_EXTS = {".pdf", ".docx", ".txt", ".md"}


def _ingest_one(table: str, target_dir: Path, original_name: str, data: bytes,
                saved: list, errors: list):
    suffix = Path(original_name).suffix.lower()
    if suffix not in SUPPORTED_EXTS:
        errors.append({"filename": original_name, "error": f"Unsupported type {suffix}"})
        return
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    stored_path = target_dir / stored_name
    stored_path.write_bytes(data)
    try:
        text = parser.extract_text(stored_path)
        if not text or len(text) < 30:
            errors.append({"filename": original_name, "error": "Empty/unreadable text"})
            stored_path.unlink(missing_ok=True)
            return
        doc_id = storage.insert_doc(table, original_name, str(stored_path), text)
        vec = embed.embed([text])[0]
        storage.set_embedding(table, doc_id, vec.tobytes())
        saved.append({"id": doc_id, "filename": original_name})
    except Exception as e:
        errors.append({"filename": original_name, "error": str(e)})
        stored_path.unlink(missing_ok=True)


@app.post("/api/upload/{kind}")
async def upload(kind: Literal["resumes", "jds"], files: list[UploadFile] = File(...)):
    import zipfile, io
    target_dir = storage.RESUMES_DIR if kind == "resumes" else storage.JDS_DIR
    saved, errors = [], []

    for f in files:
        suffix = Path(f.filename).suffix.lower()
        try:
            data = await f.read()
            if suffix == ".zip":
                try:
                    zf = zipfile.ZipFile(io.BytesIO(data))
                except zipfile.BadZipFile:
                    errors.append({"filename": f.filename, "error": "Invalid ZIP archive"})
                    continue
                count = 0
                for member in zf.infolist():
                    if member.is_dir():
                        continue
                    inner_name = Path(member.filename).name
                    if Path(inner_name).suffix.lower() not in SUPPORTED_EXTS:
                        continue
                    _ingest_one(kind, target_dir, inner_name, zf.read(member), saved, errors)
                    count += 1
                if count == 0:
                    errors.append({"filename": f.filename, "error": "ZIP contained no supported files"})
            else:
                _ingest_one(kind, target_dir, f.filename, data, saved, errors)
        except Exception as e:
            errors.append({"filename": f.filename, "error": str(e)})

    return {"saved": saved, "errors": errors}


@app.post("/api/paste/jd")
async def paste_jd(payload: dict):
    title = (payload.get("title") or "").strip() or "Pasted JD"
    text = (payload.get("text") or "").strip()
    if len(text) < 30:
        raise HTTPException(400, "Text too short (min 30 chars)")
    safe = "".join(c for c in title if c.isalnum() or c in " ._-")[:80].strip() or "Pasted JD"
    filename = f"{safe}.txt"
    stored_name = f"{uuid.uuid4().hex}.txt"
    stored_path = storage.JDS_DIR / stored_name
    stored_path.write_text(text, encoding="utf-8")
    doc_id = storage.insert_doc("jds", filename, str(stored_path), text)
    vec = embed.embed([text])[0]
    storage.set_embedding("jds", doc_id, vec.tobytes())
    return {"id": doc_id, "filename": filename}


@app.get("/api/list/{kind}")
def list_kind(kind: Literal["resumes", "jds"]):
    return storage.list_docs(kind)


@app.delete("/api/{kind}/{doc_id}")
def delete_doc(kind: Literal["resumes", "jds"], doc_id: int):
    doc = storage.get_doc(kind, doc_id)
    if not doc:
        raise HTTPException(404)
    Path(doc["stored_path"]).unlink(missing_ok=True)
    storage.delete_doc(kind, doc_id)
    return {"ok": True}


@app.get("/api/file/{kind}/{doc_id}")
def get_file(kind: Literal["resumes", "jds"], doc_id: int):
    doc = storage.get_doc(kind, doc_id)
    if not doc:
        raise HTTPException(404)
    return FileResponse(doc["stored_path"], filename=doc["filename"])


@app.get("/api/text/{kind}/{doc_id}")
def get_text(kind: Literal["resumes", "jds"], doc_id: int):
    doc = storage.get_doc(kind, doc_id)
    if not doc:
        raise HTTPException(404)
    return {"id": doc["id"], "filename": doc["filename"], "text": doc["text"]}


@app.post("/api/rank/{jd_id}")
def rank_jd(jd_id: int, top_k: int | None = None):
    jd = storage.get_doc("jds", jd_id)
    if not jd:
        raise HTTPException(404, "JD not found")
    resumes = storage.all_with_embeddings("resumes")
    if not resumes:
        raise HTTPException(400, "No resumes uploaded")

    k = top_k or int(os.environ.get("TOP_K", "15"))
    jd_vec = np.frombuffer(jd["embedding"], dtype=np.float32)
    resume_vecs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in resumes])
    pairs = embed.cosine_topk(jd_vec, resume_vecs, k)

    results = []
    for idx, sim in pairs:
        r = resumes[idx]
        try:
            llm = rank.score_resume_against_jd(jd["text"], r["text"])
        except Exception as e:
            llm = {
                "score": 0,
                "verdict": "Weak Match",
                "strengths": [],
                "gaps": [f"LLM error: {e}"],
                "summary": "",
            }
        storage.upsert_score(jd_id, r["id"], sim, llm)
        results.append({
            "resume_id": r["id"],
            "filename": r["filename"],
            "embed_score": sim,
            **llm,
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return {"jd_id": jd_id, "jd_filename": jd["filename"], "top_k": k, "candidates_evaluated": len(resumes), "results": results}


@app.get("/api/rank/{jd_id}/stream")
def rank_stream(jd_id: int, top_k: int | None = None):
    jd = storage.get_doc("jds", jd_id)
    if not jd:
        raise HTTPException(404, "JD not found")
    resumes = storage.all_with_embeddings("resumes")
    if not resumes:
        raise HTTPException(400, "No resumes uploaded")

    jd_vec = np.frombuffer(jd["embedding"], dtype=np.float32)
    resume_vecs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in resumes])
    k = top_k or embed.auto_k(jd_vec, resume_vecs)
    pairs = embed.cosine_topk(jd_vec, resume_vecs, k)

    def event_stream():
        yield _sse("start", {
            "jd_id": jd_id, "jd_filename": jd["filename"],
            "total": len(pairs), "candidates_evaluated": len(resumes), "auto_k": k,
        })
        for i, (idx, sim) in enumerate(pairs, 1):
            r = resumes[idx]
            try:
                llm = rank.score_resume_against_jd(jd["text"], r["text"])
            except Exception as e:
                import traceback
                print(f"[cvstack] LLM error for {r['filename']}: {e}")
                traceback.print_exc()
                llm = {
                    "score": 0, "verdict": "Weak Match", "confidence": "Low",
                    "candidate_snapshot": {}, "must_have_matches": [],
                    "must_have_gaps": [{"requirement": "Scoring failed", "impact": "Critical", "note": str(e)}],
                    "nice_to_have_matches": [], "skills_matched": [], "skills_missing": [],
                    "experience_alignment": "", "domain_alignment": "",
                    "red_flags": [f"LLM call failed: {type(e).__name__}: {e}"],
                    "interview_focus_areas": [],
                    "recommendation": "Could not score — see red flags.",
                    "summary": f"Scoring error: {e}",
                }
            storage.upsert_score(jd_id, r["id"], sim, llm)
            yield _sse("result", {
                "i": i, "total": len(pairs),
                "resume_id": r["id"], "filename": r["filename"],
                "embed_score": sim, **llm,
            })
        yield _sse("done", {"jd_id": jd_id})

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/rank-all/stream")
def rank_all_stream(top_k: int | None = None):
    jds = storage.all_jds()
    resumes = storage.all_with_embeddings("resumes")
    if not jds:
        raise HTTPException(400, "No JDs uploaded")
    if not resumes:
        raise HTTPException(400, "No resumes uploaded")

    resume_vecs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in resumes])
    # precompute per-JD K (auto unless overridden)
    jd_ks = []
    for jd in jds:
        jd_vec = np.frombuffer(jd["embedding"], dtype=np.float32)
        jd_ks.append(top_k or embed.auto_k(jd_vec, resume_vecs))
    total_pairs = sum(jd_ks)

    def event_stream():
        yield _sse("start", {
            "jd_count": len(jds), "resume_count": len(resumes),
            "auto_k_avg": round(sum(jd_ks) / len(jd_ks), 1) if jd_ks else 0,
            "total_pairs": total_pairs,
        })
        completed = 0
        for ji, (jd, k) in enumerate(zip(jds, jd_ks), 1):
            jd_vec = np.frombuffer(jd["embedding"], dtype=np.float32)
            pairs = embed.cosine_topk(jd_vec, resume_vecs, k)
            yield _sse("jd_start", {
                "jd_index": ji, "jd_id": jd["id"], "jd_filename": jd["filename"],
                "shortlist": len(pairs),
            })
            for idx, sim in pairs:
                r = resumes[idx]
                try:
                    llm = rank.score_resume_against_jd(jd["text"], r["text"])
                except Exception as e:
                    import traceback
                    print(f"[cvstack] LLM error for {r['filename']} vs {jd['filename']}: {e}")
                    traceback.print_exc()
                    llm = {"score": 0, "verdict": "Weak Match", "confidence": "Low",
                           "summary": f"Scoring error: {e}",
                           "red_flags": [f"LLM call failed: {type(e).__name__}: {e}"]}
                storage.upsert_score(jd["id"], r["id"], sim, llm)
                completed += 1
                yield _sse("pair", {
                    "completed": completed, "total": total_pairs,
                    "jd_id": jd["id"], "jd_filename": jd["filename"],
                    "resume_id": r["id"], "resume_filename": r["filename"],
                    "score": llm.get("score", 0), "verdict": llm.get("verdict", ""),
                })
            yield _sse("jd_done", {"jd_id": jd["id"], "jd_index": ji})
        yield _sse("done", {"total": completed})

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/matrix")
def matrix(top_n: int = 5):
    return {"matrix": storage.matrix_summary(top_n=top_n)}


@app.get("/api/resume/{resume_id}/best-jds")
def best_jds(resume_id: int):
    r = storage.get_doc("resumes", resume_id)
    if not r:
        raise HTTPException(404)
    return {"resume_id": resume_id, "filename": r["filename"],
            "results": storage.best_jds_for_resume(resume_id)}


@app.get("/api/results/{jd_id}")
def results(jd_id: int):
    jd = storage.get_doc("jds", jd_id)
    if not jd:
        raise HTTPException(404)
    return {"jd_id": jd_id, "jd_filename": jd["filename"], "results": storage.results_for_jd(jd_id)}


@app.get("/api/export/{jd_id}.csv")
def export_csv(jd_id: int):
    import csv, io
    jd = storage.get_doc("jds", jd_id)
    if not jd:
        raise HTTPException(404)
    rows = storage.results_for_jd(jd_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "rank", "resume_filename", "score", "verdict", "confidence",
        "current_role", "experience_years", "domain",
        "primary_skills", "skills_matched", "skills_missing",
        "must_have_matches", "must_have_gaps", "nice_to_haves",
        "experience_alignment", "domain_alignment",
        "red_flags", "interview_focus_areas",
        "recommendation", "summary", "embed_similarity",
    ])
    for i, r in enumerate(rows, 1):
        snap = r.get("candidate_snapshot") or {}
        def joinl(items, fmt=str):
            return " | ".join(fmt(x) for x in (items or []))
        w.writerow([
            i,
            r.get("resume_filename", ""),
            r.get("score") or r.get("llm_score") or "",
            r.get("verdict", ""),
            r.get("confidence", ""),
            snap.get("current_role", ""),
            snap.get("total_experience_years", ""),
            snap.get("domain_background", ""),
            joinl(snap.get("primary_skills")),
            joinl(r.get("skills_matched")),
            joinl(r.get("skills_missing")),
            joinl(r.get("must_have_matches"), lambda m: f"{m.get('requirement','')}: {m.get('evidence','')}"),
            joinl(r.get("must_have_gaps"), lambda g: f"[{g.get('impact','')}] {g.get('requirement','')}: {g.get('note','')}"),
            joinl(r.get("nice_to_have_matches")),
            r.get("experience_alignment", ""),
            r.get("domain_alignment", ""),
            joinl(r.get("red_flags")),
            joinl(r.get("interview_focus_areas")),
            r.get("recommendation", ""),
            r.get("summary", ""),
            f"{r.get('embed_score') or 0:.4f}",
        ])
    csv_data = "\ufeff" + buf.getvalue()  # BOM for Excel
    safe = "".join(c for c in jd["filename"] if c.isalnum() or c in "._-")[:50] or f"jd{jd_id}"
    return StreamingResponse(
        iter([csv_data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="cvstack_{safe}.csv"'},
    )


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
