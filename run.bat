@echo off
if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate
)
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
