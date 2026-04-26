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
