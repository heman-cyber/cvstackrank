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

// ----- Tabs -----
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach(p => {
      p.hidden = p.dataset.panel !== btn.dataset.tab;
    });
    if (btn.dataset.tab === "bulk") loadMatrix();
    if (btn.dataset.tab === "reverse") loadReverseSelect();
  });
});

// ----- Bulk rank -----
$("#bulk-rank-btn").addEventListener("click", () => {
  const k = Number($("#bulk-top-k").value) || 10;
  $("#bulk-rank-btn").disabled = true;
  $("#bulk-progress-wrap").hidden = false;
  $("#bulk-progress-fill").style.width = "0%";
  $("#bulk-progress-text").textContent = "Starting…";
  $("#matrix").innerHTML = "";

  const es = new EventSource(`/api/rank-all/stream?top_k=${k}`, { withCredentials: false });
  // EventSource doesn't support POST natively; we use GET-style with fetch streaming instead.
  es.close();
  bulkRankFetch(k);
});

async function bulkRankFetch(k) {
  try {
    const r = await fetch(`/api/rank-all/stream?top_k=${k}`, { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let totalPairs = 1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const block of events) {
        const ev = parseSSE(block);
        if (!ev) continue;
        if (ev.event === "start") {
          totalPairs = ev.data.total_pairs || 1;
          $("#bulk-progress-text").textContent = `Scoring ${ev.data.jd_count} JDs × top ${ev.data.top_k} resumes (${totalPairs} pair-evaluations)…`;
        } else if (ev.event === "jd_start") {
          $("#bulk-progress-text").textContent = `JD ${ev.data.jd_index}: ${ev.data.jd_filename} (shortlist of ${ev.data.shortlist})`;
        } else if (ev.event === "pair") {
          const pct = Math.round((ev.data.completed / totalPairs) * 100);
          $("#bulk-progress-fill").style.width = pct + "%";
          $("#bulk-progress-text").textContent = `${ev.data.completed}/${totalPairs} — ${ev.data.resume_filename} vs ${ev.data.jd_filename} → ${ev.data.score} (${ev.data.verdict})`;
        } else if (ev.event === "done") {
          $("#bulk-progress-fill").style.width = "100%";
          $("#bulk-progress-text").textContent = `✓ Done. Scored ${ev.data.total} pairs.`;
          await loadMatrix();
          toast(`Bulk ranking complete — ${ev.data.total} pairs scored`, "success");
        }
      }
    }
  } catch (e) {
    toast(`Bulk rank failed: ${e.message}`, "error");
  } finally {
    $("#bulk-rank-btn").disabled = false;
    setTimeout(() => { $("#bulk-progress-wrap").hidden = true; }, 3000);
  }
}

function parseSSE(block) {
  const lines = block.split("\n");
  let event = "message", data = "";
  for (const l of lines) {
    if (l.startsWith("event: ")) event = l.slice(7).trim();
    else if (l.startsWith("data: ")) data += l.slice(6);
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

$("#bulk-refresh-btn").addEventListener("click", loadMatrix);

async function loadMatrix() {
  try {
    const data = await api(`/api/matrix?top_n=5`);
    renderMatrix(data.matrix);
  } catch (e) {
    toast(`Could not load matrix: ${e.message}`, "error");
  }
}

function renderMatrix(rows) {
  const root = $("#matrix");
  if (!rows.length) { root.innerHTML = `<p class="empty">No JDs uploaded.</p>`; return; }
  const allScored = rows.some(r => r.top.length > 0);
  if (!allScored) {
    root.innerHTML = `<p class="empty">No rankings yet. Click <strong>Rank all JDs</strong> to score every resume against every JD.</p>`;
    return;
  }
  root.innerHTML = `
    <table class="matrix">
      <thead>
        <tr><th class="jd-col">Job description</th><th>Top match</th><th>#2</th><th>#3</th><th>#4</th><th>#5</th></tr>
      </thead>
      <tbody>
        ${rows.map(row => {
          const cells = [0,1,2,3,4].map(i => {
            const t = row.top[i];
            if (!t) return `<td class="cell empty-cell">—</td>`;
            return `<td class="cell ${scoreClass(t.llm_score)}" title="${escape(t.filename)} — ${escape(t.verdict||"")}">
              <div class="cell-score">${t.llm_score}</div>
              <div class="cell-name">${escape(t.filename)}</div>
            </td>`;
          }).join("");
          return `<tr><td class="jd-col"><strong>${escape(row.jd_filename)}</strong><br><a href="#" data-jd="${row.jd_id}" class="jd-link">view detail →</a></td>${cells}</tr>`;
        }).join("")}
      </tbody>
    </table>`;
  root.querySelectorAll(".jd-link").forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault();
    const jdId = Number(a.dataset.jd);
    document.querySelector('.tab[data-tab="per-jd"]').click();
    selectJd(jdId);
  }));
}

// ----- Reverse lookup -----
async function loadReverseSelect() {
  const docs = await api("/api/list/resumes");
  const sel = $("#reverse-select");
  const cur = sel.value;
  sel.innerHTML = `<option value="">-- pick a resume --</option>` +
    docs.map(d => `<option value="${d.id}">${escape(d.filename)}</option>`).join("");
  sel.value = cur;
}

$("#reverse-select").addEventListener("change", async (e) => {
  const id = Number(e.target.value);
  const root = $("#reverse-results");
  if (!id) { root.innerHTML = ""; return; }
  try {
    const data = await api(`/api/resume/${id}/best-jds`);
    if (!data.results.length) {
      root.innerHTML = `<p class="empty">No JD scores yet for <strong>${escape(data.filename)}</strong>. Run <em>All JDs × All resumes</em> first.</p>`;
      return;
    }
    root.innerHTML = `<h3 style="margin:6px 0 14px; font-size:14px; color:#475569">JDs ranked for: <strong>${escape(data.filename)}</strong></h3>` +
      data.results.map((r, i) => {
        const r2 = { ...r, filename: r.filename, resume_id: id };
        // reuse renderCandidate but treat it as a JD card
        const score = r.llm_score ?? 0;
        const conf = (r.confidence || "Medium").toLowerCase();
        return `
          <details class="result-row">
            <summary class="result-head">
              <span class="caret">▸</span>
              <h3><span class="rank-num">#${i+1}</span> ${escape(r.filename)}</h3>
              <span class="one-liner">${escape(r.summary || "")}</span>
              <span class="head-pills">
                <span class="conf conf-${conf}">${escape(r.confidence || "")}</span>
                <span class="verdict ${verdictClass(r.verdict)}">${escape(r.verdict || "")}</span>
                <span class="score-pill ${scoreClass(score)}">${score}</span>
              </span>
            </summary>
            <div class="recommend"><strong>Recommendation:</strong> ${escape(r.recommendation || "—")}</div>
            <div class="actions">
              <a href="/api/file/jds/${r.jd_id}" target="_blank">📄 Open JD</a>
              <a href="#" data-jd="${r.jd_id}" class="jd-link-rev">view full ranking for this JD →</a>
            </div>
          </details>`;
      }).join("");
    root.querySelectorAll(".jd-link-rev").forEach(a => a.addEventListener("click", (e) => {
      e.preventDefault();
      const jdId = Number(a.dataset.jd);
      document.querySelector('.tab[data-tab="per-jd"]').click();
      selectJd(jdId);
    }));
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  }
});

refresh("jds");
refresh("resumes");
