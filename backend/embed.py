import numpy as np
from sentence_transformers import SentenceTransformer

_MODEL = None
_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def model() -> SentenceTransformer:
    global _MODEL
    if _MODEL is None:
        _MODEL = SentenceTransformer(_MODEL_NAME)
    return _MODEL


def embed(texts: list[str]) -> np.ndarray:
    vecs = model().encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return np.asarray(vecs, dtype=np.float32)


def cosine_topk(jd_vec: np.ndarray, resume_vecs: np.ndarray, k: int) -> list[tuple[int, float]]:
    sims = resume_vecs @ jd_vec
    k = min(k, len(sims))
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]
    return [(int(i), float(sims[i])) for i in idx]
