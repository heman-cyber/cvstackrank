const $ = (s) => document.querySelector(s);
let selectedJdId = null;

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

async function refresh(kind) {
  const docs = await api(`/api/list/${kind}`);
  const ul = $(`#${kind === "resumes" ? "resume" : "jd"}-list`);
  const empty = $(`#${kind === "resumes" ? "resume" : "jd"}-empty`);
  $(`#${kind === "resumes" ? "resume" : "jd"}-count`).textContent = docs.length;
  empty.classList.toggle("hidden", docs.length > 0);

  ul.innerHTML = "";
  docs.forEach((d) => {
    const li = document.createElement("li");
    li.dataset.id = d.id;

    if (kind === "jds") {
      const check = document.createElement("span");
      check.className = "check";
      li.appendChild(check);
      if (selectedJdId === d.id) li.classList.add("selected");
      li.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        selectJd(d.id);
      });
    }

    const name = document.createElement("span");
    name.className = "filename"; name.textContent = d.filename;
    li.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${Math.round(d.text_len / 100) / 10}k chars`;
    li.appendChild(meta);

    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×"; del.title = "Delete";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${d.filename}?`)) return;
      await api(`/api/${kind}/${d.id}`, { method: "DELETE" });
      if (kind === "jds" && selectedJdId === d.id) {
        selectedJdId = null;
        $("#selected-line").textContent = "Select a JD on the left to begin.";
        $("#results").innerHTML = "";
      }
      refresh(kind);
      updateRankBtn();
    };
    li.appendChild(del);
    ul.appendChild(li);
  });
}

function selectJd(id) {
  selectedJdId = id;
  document.querySelectorAll("#jd-list li").forEach((li) => {
    li.classList.toggle("selected", Number(li.dataset.id) === id);
  });
  const filename = document.querySelector(`#jd-list li[data-id="${id}"] .filename`)?.textContent || "";
  $("#selected-line").innerHTML = `Selected JD: <strong>${escape(filename)}</strong>`;
  updateRankBtn();
  loadCachedResults(id);
}

function updateRankBtn() {
  $("#rank-btn").disabled = !selectedJdId;
}

async function loadCachedResults(jdId) {
  try {
    const data = await api(`/api/results/${jdId}`);
    if (data.results.length) {
      const adapted = data.results.map(r => ({
        ...r,
        score: r.llm_score,
        filename: r.resume_filename,
      }));
      renderResults(adapted, data.jd_filename, true);
    } else {
      $("#results").innerHTML = `<p class="empty">No ranking yet for this JD. Click <strong>Rank candidates</strong>.</p>`;
    }
  } catch {}
}

async function upload(kind, files, label) {
  if (!files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append("files", f));
  label.classList.add("uploading");
  toast(`Uploading ${files.length} file(s)…`);
  try {
    const res = await api(`/api/upload/${kind}`, { method: "POST", body: fd });
    if (res.errors.length) {
      toast(`Uploaded ${res.saved.length}, ${res.errors.length} failed: ${res.errors[0].filename} (${res.errors[0].error})`, "error");
    } else {
      toast(`✓ Uploaded ${res.saved.length} file(s)`, "success");
    }
    await refresh(kind);
  } catch (e) {
    toast(`Upload failed: ${e.message}`, "error");
  } finally {
    label.classList.remove("uploading");
  }
}

$("#jd-files").addEventListener("change", (e) => {
  upload("jds", e.target.files, $("#jd-upload-label")).then(() => e.target.value = "");
});
$("#resume-files").addEventListener("change", (e) => {
  upload("resumes", e.target.files, $("#resume-upload-label")).then(() => e.target.value = "");
});

function wireDrop(zoneId, kind, labelId) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;
  ["dragenter", "dragover"].forEach(ev =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(ev =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files?.length) upload(kind, e.dataTransfer.files, document.getElementById(labelId));
  });
}
wireDrop("jd-drop", "jds", "jd-upload-label");
wireDrop("resume-drop", "resumes", "resume-upload-label");

$("#expand-all").addEventListener("click", () => {
  const all = document.querySelectorAll("#results details");
  const anyClosed = [...all].some(d => !d.open);
  all.forEach(d => d.open = anyClosed);
  $("#expand-all").textContent = anyClosed ? "Collapse all" : "Expand all";
});

$("#export-btn").addEventListener("click", () => {
  if (!selectedJdId) return;
  window.location = `/api/export/${selectedJdId}.csv`;
});

$("#rank-btn").addEventListener("click", () => {
  if (!selectedJdId) return;
  const k = Number($("#top-k").value) || 15;
  startRanking(selectedJdId, k);
});

function startRanking(jdId, k) {
  $("#rank-btn").disabled = true;
  $("#results").innerHTML = "";
  $("#progress-wrap").hidden = false;
  $("#progress-fill").style.width = "0%";
  $("#progress-text").textContent = "Starting…";
  setStatus("");

  const es = new EventSource(`/api/rank/${jdId}/stream?top_k=${k}`);
  const collected = [];
  let total = k;

  es.addEventListener("start", (ev) => {
    const d = JSON.parse(ev.data);
    total = d.total;
    $("#progress-text").textContent = `Embedding shortlist done. Scoring ${d.total} of ${d.candidates_evaluated} resumes with Claude…`;
  });

  es.addEventListener("result", (ev) => {
    const d = JSON.parse(ev.data);
    collected.push(d);
    const pct = Math.round((d.i / total) * 100);
    $("#progress-fill").style.width = pct + "%";
    $("#progress-text").textContent = `Scored ${d.i}/${total}: ${d.filename} → ${d.score} (${d.verdict})`;
    collected.sort((a, b) => b.score - a.score);
    renderResults(collected, null, false, total);
  });

  es.addEventListener("done", () => {
    es.close();
    $("#progress-fill").style.width = "100%";
    $("#progress-text").textContent = `✓ Done. Scored ${collected.length} candidates.`;
    setTimeout(() => { $("#progress-wrap").hidden = true; }, 2500);
    $("#rank-btn").disabled = false;
    toast(`Ranking complete — ${collected.length} candidates scored`, "success");
  });

  es.onerror = () => {
    es.close();
    $("#rank-btn").disabled = false;
    $("#progress-text").textContent = "Connection ended.";
    if (!collected.length) toast("Ranking failed — check server logs", "error");
  };
}

function setStatus(msg) { $("#status").textContent = msg; }

function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3500);
}

function verdictClass(v) {
  v = (v || "").toLowerCase();
  if (v.startsWith("strong")) return "v-strong";
  if (v.startsWith("good")) return "v-good";
  if (v.startsWith("partial")) return "v-partial";
  return "v-weak";
}
function scoreClass(s) {
  if (s >= 75) return "s-high";
  if (s >= 50) return "s-mid";
  return "s-low";
}

function renderResults(results, jdFilename, cached, expectedTotal) {
  const root = $("#results");
  if (!results.length) { root.innerHTML = ""; return; }
  const header = jdFilename
    ? `<h3 style="margin:6px 0 14px; font-size:14px; color:#475569">Ranked candidates for: <strong>${escape(jdFilename)}</strong>${cached ? ' <span style="color:#94a3b8; font-weight:400">(cached)</span>' : ""}</h3>`
    : (expectedTotal ? `<h3 style="margin:6px 0 14px; font-size:14px; color:#475569">Live results (${results.length} of ${expectedTotal})</h3>` : "");
  root.innerHTML = header + results.map((r, i) => renderCandidate(r, i)).join("");
  const has = results.length > 0;
  $("#export-btn").disabled = !has;
  $("#expand-all").disabled = !has;
}

function renderCandidate(r, i) {
  const score = r.score ?? 0;
  const filename = r.filename || r.resume_filename;
  const snap = r.candidate_snapshot || {};
  const conf = (r.confidence || "Medium").toLowerCase();
  const oneLiner = `${escape(snap.current_role || "—")} · ${snap.total_experience_years != null ? snap.total_experience_years + "y" : "—"} · ${escape(snap.domain_background || "—")}`;
  const primarySkills = (snap.primary_skills || []).map(s => `<span class="chip">${escape(s)}</span>`).join("");
  const skillsMatched = (r.skills_matched || []).map(s => `<span class="chip chip-good">${escape(s)}</span>`).join("");
  const skillsMissing = (r.skills_missing || []).map(s => `<span class="chip chip-bad">${escape(s)}</span>`).join("");
  const niceToHave = (r.nice_to_have_matches || []).map(s => `<span class="chip chip-soft">${escape(s)}</span>`).join("");

  const matches = (r.must_have_matches || []).map(m => `
    <li><strong>${escape(m.requirement || "")}</strong>${m.evidence ? ` — <span class="evidence">${escape(m.evidence)}</span>` : ""}</li>`).join("");
  const gaps = (r.must_have_gaps || []).map(g => `
    <li><span class="impact impact-${(g.impact||"").toLowerCase()}">${escape(g.impact || "")}</span> <strong>${escape(g.requirement || "")}</strong>${g.note ? ` — ${escape(g.note)}` : ""}</li>`).join("");
  const flags = (r.red_flags || []).map(s => `<li>${escape(s)}</li>`).join("");
  const focus = (r.interview_focus_areas || []).map(s => `<li>${escape(s)}</li>`).join("");

  return `
    <details class="result-row">
      <summary class="result-head">
        <span class="caret">▸</span>
        <h3><span class="rank-num">#${i + 1}</span> ${escape(filename)}</h3>
        <span class="one-liner">${oneLiner}</span>
        <span class="head-pills">
          <span class="conf conf-${conf}">${escape(r.confidence || "")}</span>
          <span class="verdict ${verdictClass(r.verdict)}">${escape(r.verdict || "")}</span>
          <span class="score-pill ${scoreClass(score)}">${score}</span>
        </span>
      </summary>

      <div class="snapshot">
        <div><span class="lbl">Current</span> ${escape(snap.current_role || "—")}</div>
        <div><span class="lbl">Experience</span> ${snap.total_experience_years != null ? snap.total_experience_years + " yrs" : "—"}</div>
        <div><span class="lbl">Domain</span> ${escape(snap.domain_background || "—")}</div>
      </div>
      ${primarySkills ? `<div class="chip-row"><span class="lbl">Primary skills:</span> ${primarySkills}</div>` : ""}

      <div class="detail-grid">
        <div class="detail-block">
          <h4>✓ Must-have matches</h4>
          <ul class="ml">${matches || '<li><em>none</em></li>'}</ul>
        </div>
        <div class="detail-block">
          <h4>✗ Must-have gaps</h4>
          <ul class="ml">${gaps || '<li><em>none</em></li>'}</ul>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-block">
          <h4>Skills matched</h4>
          <div class="chip-row">${skillsMatched || '<span class="muted">none</span>'}</div>
        </div>
        <div class="detail-block">
          <h4>Skills missing</h4>
          <div class="chip-row">${skillsMissing || '<span class="muted">none</span>'}</div>
        </div>
      </div>

      ${niceToHave ? `<div class="chip-row"><span class="lbl">Nice-to-haves:</span> ${niceToHave}</div>` : ""}

      <div class="detail-grid">
        <div class="detail-block">
          <h4>Experience alignment</h4>
          <p>${escape(r.experience_alignment || "—")}</p>
        </div>
        <div class="detail-block">
          <h4>Domain alignment</h4>
          <p>${escape(r.domain_alignment || "—")}</p>
        </div>
      </div>

      ${flags ? `<div class="detail-block flags"><h4>⚠ Red flags</h4><ul class="ml">${flags}</ul></div>` : ""}
      ${focus ? `<div class="detail-block"><h4>Interview focus areas</h4><ul class="ml">${focus}</ul></div>` : ""}

      <div class="recommend"><strong>Recommendation:</strong> ${escape(r.recommendation || "—")}</div>
      <div class="summary">${escape(r.summary || "")}</div>
      <div class="actions">
        <a href="/api/file/resumes/${r.resume_id}" target="_blank">📄 Open resume</a>
        <span style="color:#cbd5e1; font-size:12px">embed sim: ${(r.embed_score || 0).toFixed(3)}</span>
      </div>
    </details>`;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

refresh("jds");
refresh("resumes");
