import json
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "cvstack.db"
RESUMES_DIR = DATA_DIR / "resumes"
JDS_DIR = DATA_DIR / "jds"

for d in (DATA_DIR, RESUMES_DIR, JDS_DIR):
    d.mkdir(parents=True, exist_ok=True)


def init_db():
    with conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS resumes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS jds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jd_id INTEGER NOT NULL,
            resume_id INTEGER NOT NULL,
            embed_score REAL,
            llm_score REAL,
            verdict TEXT,
            summary TEXT,
            detail_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(jd_id, resume_id)
        );
        """)
        # migrate older DBs that lack detail_json
        cols = {r[1] for r in c.execute("PRAGMA table_info(scores)").fetchall()}
        if "detail_json" not in cols:
            c.execute("ALTER TABLE scores ADD COLUMN detail_json TEXT")


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def insert_doc(table: str, filename: str, stored_path: str, text: str) -> int:
    with conn() as c:
        cur = c.execute(
            f"INSERT INTO {table} (filename, stored_path, text) VALUES (?, ?, ?)",
            (filename, stored_path, text),
        )
        return cur.lastrowid


def set_embedding(table: str, doc_id: int, vec_bytes: bytes):
    with conn() as c:
        c.execute(f"UPDATE {table} SET embedding=? WHERE id=?", (vec_bytes, doc_id))


def list_docs(table: str) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            f"SELECT id, filename, created_at, length(text) AS text_len, embedding IS NOT NULL AS has_embedding FROM {table} ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


def get_doc(table: str, doc_id: int) -> dict | None:
    with conn() as c:
        r = c.execute(f"SELECT * FROM {table} WHERE id=?", (doc_id,)).fetchone()
        return dict(r) if r else None


def all_with_embeddings(table: str) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            f"SELECT id, filename, text, embedding FROM {table} WHERE embedding IS NOT NULL"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_score(jd_id: int, resume_id: int, embed_score: float, llm: dict | None):
    llm = llm or {}
    with conn() as c:
        c.execute(
            """INSERT INTO scores (jd_id, resume_id, embed_score, llm_score, verdict, summary, detail_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(jd_id, resume_id) DO UPDATE SET
                 embed_score=excluded.embed_score,
                 llm_score=excluded.llm_score,
                 verdict=excluded.verdict,
                 summary=excluded.summary,
                 detail_json=excluded.detail_json,
                 created_at=CURRENT_TIMESTAMP""",
            (
                jd_id, resume_id, embed_score,
                llm.get("score"), llm.get("verdict"), llm.get("summary"),
                json.dumps(llm),
            ),
        )


def results_for_jd(jd_id: int) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            """SELECT s.*, r.filename AS resume_filename
               FROM scores s JOIN resumes r ON r.id = s.resume_id
               WHERE s.jd_id = ?
               ORDER BY COALESCE(s.llm_score, s.embed_score*100) DESC""",
            (jd_id,),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            detail = json.loads(d.get("detail_json") or "{}")
            d.update(detail)
            out.append(d)
        return out


def matrix_summary(top_n: int = 5) -> list[dict]:
    """For each JD, return top N candidates with scores."""
    with conn() as c:
        jds = c.execute("SELECT id, filename FROM jds ORDER BY id").fetchall()
        out = []
        for jd in jds:
            rows = c.execute(
                """SELECT s.resume_id, s.llm_score, s.verdict, s.embed_score, r.filename
                   FROM scores s JOIN resumes r ON r.id = s.resume_id
                   WHERE s.jd_id = ? AND s.llm_score IS NOT NULL
                   ORDER BY s.llm_score DESC LIMIT ?""",
                (jd["id"], top_n),
            ).fetchall()
            out.append({
                "jd_id": jd["id"], "jd_filename": jd["filename"],
                "top": [dict(r) for r in rows],
            })
        return out


def best_jds_for_resume(resume_id: int) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            """SELECT s.jd_id, s.llm_score, s.verdict, s.embed_score, j.filename, s.detail_json
               FROM scores s JOIN jds j ON j.id = s.jd_id
               WHERE s.resume_id = ? AND s.llm_score IS NOT NULL
               ORDER BY s.llm_score DESC""",
            (resume_id,),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            detail = json.loads(d.pop("detail_json") or "{}")
            d.update(detail)
            out.append(d)
        return out


def all_jds() -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, filename, text, embedding FROM jds WHERE embedding IS NOT NULL"
        ).fetchall()]


def delete_doc(table: str, doc_id: int):
    with conn() as c:
        if table == "resumes":
            c.execute("DELETE FROM scores WHERE resume_id=?", (doc_id,))
        elif table == "jds":
            c.execute("DELETE FROM scores WHERE jd_id=?", (doc_id,))
        c.execute(f"DELETE FROM {table} WHERE id=?", (doc_id,))
