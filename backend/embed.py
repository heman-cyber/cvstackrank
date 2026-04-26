import numpy as np
from fastembed import TextEmbedding

_MODEL = None
_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def model() -> TextEmbedding:
    global _MODEL
    if _MODEL is None:
        _MODEL = TextEmbedding(model_name=_MODEL_NAME)
    return _MODEL


def embed(texts: list[str]) -> np.ndarray:
    vecs = list(model().embed(texts))
    arr = np.asarray(vecs, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def cosine_topk(jd_vec: np.ndarray, resume_vecs: np.ndarray, k: int) -> list[tuple[int, float]]:
    sims = resume_vecs @ jd_vec
    k = min(k, len(sims))
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]
    return [(int(i), float(sims[i])) for i in idx]


def auto_k(jd_vec: np.ndarray, resume_vecs: np.ndarray,
           min_k: int = 10, max_k: int = 50, sim_floor: float = 0.20) -> int:
    """Pick a sensible K based on resume count and similarity distribution."""
    n = len(resume_vecs)
    if n <= min_k:
        return n
    sims = resume_vecs @ jd_vec
    sims_sorted = np.sort(sims)[::-1]
    base_k = max(min_k, min(max_k, int(round(n * 0.20))))
    while base_k > min_k and sims_sorted[base_k - 1] < sim_floor:
        base_k -= 1
    return base_k
