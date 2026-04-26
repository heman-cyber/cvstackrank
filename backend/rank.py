import json
import os
import re
from anthropic import Anthropic

_CLIENT = None


def client() -> Anthropic:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _CLIENT


def model_name() -> str:
    return os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")


SYSTEM = """You are a senior technical recruiter and bench-management analyst evaluating how well a candidate's resume matches a job description. Your job is to produce a rigorous, structured assessment a workforce manager can act on.

Be strict and calibrated:
- "Strong Match" (85-100): clear alignment on must-haves (years, core stack, domain), no critical gaps.
- "Good Match" (70-84): most must-haves met, minor gaps.
- "Partial Match" (50-69): some must-haves met, significant gaps that need bridging.
- "Weak Match" (0-49): missing core requirements.

Always cite specific evidence from the resume (project names, tech, years, companies). If something is inferred rather than stated, say so. If the resume is sparse or unclear, lower confidence.

Return a single JSON object — no prose, no markdown fences — with EXACTLY these keys:

{
  "score": integer 0-100,
  "verdict": "Strong Match" | "Good Match" | "Partial Match" | "Weak Match",
  "confidence": "High" | "Medium" | "Low",
  "candidate_snapshot": {
    "current_role": string (best inference of current/most recent role + company, or "Unknown"),
    "total_experience_years": number (best estimate, 0 if unclear),
    "primary_skills": array of 3-6 short strings (the candidate's strongest technical skills based on resume),
    "domain_background": string (one short phrase, e.g. "Automotive embedded software", "Enterprise SaaS")
  },
  "must_have_matches": array of 0-6 objects { "requirement": short string, "evidence": short string citing resume } — JD must-haves the candidate clearly meets,
  "must_have_gaps": array of 0-6 objects { "requirement": short string, "impact": "Critical" | "Major" | "Minor", "note": short string } — JD must-haves not met,
  "nice_to_have_matches": array of 0-5 short strings — bonus alignments,
  "skills_matched": array of short strings — JD-required skills found in resume,
  "skills_missing": array of short strings — JD-required skills NOT found,
  "experience_alignment": string (1-2 sentences on whether years and seniority align with JD),
  "domain_alignment": string (1-2 sentences on industry/domain fit),
  "red_flags": array of 0-4 short strings — concerns (job hopping, unrelated background, gaps in employment, etc.); empty array if none,
  "interview_focus_areas": array of 2-5 short strings — what to probe in a screening call,
  "recommendation": string (1-2 sentence actionable recommendation for bench placement: shortlist / hold / reject, and why),
  "summary": string (single sentence overall takeaway)
}

Do not invent skills or experience not present in the resume. If a field has no items, return an empty array."""


def score_resume_against_jd(jd_text: str, resume_text: str) -> dict:
    msg = client().messages.create(
        model=model_name(),
        max_tokens=2000,
        system=SYSTEM,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"<job_description>\n{jd_text}\n</job_description>",
                        "cache_control": {"type": "ephemeral"},
                    },
                    {
                        "type": "text",
                        "text": f"<resume>\n{resume_text}\n</resume>\n\nReturn the JSON object now.",
                    },
                ],
            }
        ],
    )
    raw = "".join(b.text for b in msg.content if hasattr(b, "text")).strip()
    parsed = _parse_json(raw)
    if parsed.get("score") == 0 and not parsed.get("must_have_matches") and not parsed.get("must_have_gaps"):
        print(f"[cvstack] suspect empty parse. raw[:500]={raw[:500]!r}")
    return parsed


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {
            "score": 0, "verdict": "Weak Match", "confidence": "Low",
            "candidate_snapshot": {}, "must_have_matches": [], "must_have_gaps": [],
            "nice_to_have_matches": [], "skills_matched": [], "skills_missing": [],
            "experience_alignment": "", "domain_alignment": "",
            "red_flags": ["LLM returned unparseable response"],
            "interview_focus_areas": [], "recommendation": "Could not parse model output.",
            "summary": "Could not parse model output.",
        }
    data["score"] = int(max(0, min(100, data.get("score", 0))))
    data.setdefault("verdict", "Partial Match")
    data.setdefault("confidence", "Medium")
    data.setdefault("candidate_snapshot", {})
    for k in ("must_have_matches", "must_have_gaps", "nice_to_have_matches",
              "skills_matched", "skills_missing", "red_flags", "interview_focus_areas"):
        data.setdefault(k, [])
    for k in ("experience_alignment", "domain_alignment", "recommendation", "summary"):
        data.setdefault(k, "")
    return data
