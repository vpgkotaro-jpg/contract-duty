import {
  addDays, fmt, weekdayName, isDate, lastSafeDay, firstReminder, schedule,
  applyReply, applyProof, tick, fallbackReply, cancelSteps,
} from "./agent.js";

const KEY = "keiyaku-touban-v1";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const realToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const long = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function fresh() {
  return { today: realToday(), contracts: [], threads: {}, logs: {}, selected: null, pending: null };
}
let S;
try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { S = fresh(); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

// ---------- sample emails (fictional services) ----------
const SAMPLES = [
  {
    label: "Music trial · Apple",
    text: (t) => `From: Melodia Music <no-reply@melodia.example>
Subject: Welcome to Melodia Premium

Hi! Your 1-month free trial of Melodia Premium has started.
Your trial ends on ${long(addDays(t, 30))}. After that, your subscription renews automatically at ¥1,080/month.
Billing is handled by Apple. You can manage or cancel your subscription in your Apple ID settings.
Enjoy ad-free music!`,
  },
  {
    label: "PDF tool · 3-day trial",
    text: (t) => `From: QuickPDF Pro <billing@quickpdf.example>
Subject: Your 3-day free trial is active

Thanks for trying QuickPDF Pro. Your 3-day free trial ends ${long(addDays(t, 3))}.
Unless you cancel before then, we'll charge your card $9.99 per month.
Cancel anytime: https://quickpdf.example/account/billing`,
  },
  {
    label: "Promo (not a contract)",
    text: () => `From: FitNest <news@fitnest.example>
Subject: 50% off FitNest Premium — this week only!

New members get 50% off their first 3 months. Join today and start your fitness journey.
Unsubscribe from marketing emails here.`,
  },
  {
    label: "Yearly renewal · Google Play",
    text: (t) => `From: Google Play <googleplay-noreply@google.example>
Subject: Your subscription to CloudNotes Yearly will renew soon

Your CloudNotes Yearly subscription will automatically renew on ${long(addDays(t, 40))} for ¥4,800/year.
To cancel, open Google Play > Payments & subscriptions.`,
  },
];

// ---------- API ----------
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- rendering ----------
const STATUS = {
  chasing: ["Chasing", "s-chase"],
  awaiting_proof: ["Waiting for proof", "s-proof"],
  keeping: ["Keeping", "s-keep"],
  closed: ["Cancelled ✓", "s-done"],
  missed: ["Missed — charged", "s-miss"],
};
const BILLED = { apple: "Apple", google_play: "Google Play", direct: "Direct", unknown: "Unknown" };
const money = (c) => (c.price ? `${c.currency || ""} ${c.price}`.trim() : "—");

function renderClock() {
  $("#today").textContent = fmt(S.today) + ", " + S.today.slice(0, 4);
}

function renderSamples() {
  $("#samples").innerHTML = SAMPLES.map((s, i) => `<button class="chip" data-i="${i}">${esc(s.label)}</button>`).join("");
}

function renderPending() {
  const box = $("#emailResult");
  const p = S.pending;
  if (!p) { box.innerHTML = ""; return; }
  if (p.error) { box.innerHTML = `<div class="note bad">AI couldn't read it: ${esc(p.error)}. Try again in a moment.</div>`; return; }
  if (!p.is_contract || p.kind === "none") {
    box.innerHTML = `<div class="note">Not a contract — ignored. <span class="muted">AI: ${esc(p.reason)}</span></div>`;
    return;
  }
  box.innerHTML = `
  <div class="read">
    <div class="readHead">AI read this — check it before adding <span class="muted">(${esc(p.reason)})</span></div>
    <div class="fields">
      <label>Service<input id="f_service" value="${esc(p.service)}"></label>
      <label>Ends / renews<input id="f_end" type="date" value="${esc(isDate(p.end_date) ? p.end_date : "")}"></label>
      <label>Price<input id="f_price" value="${esc(p.price || "")}" placeholder="not stated"></label>
      <label>Currency<input id="f_cur" value="${esc(p.currency || "")}"></label>
      <label>Kind<select id="f_kind">${["free_trial", "monthly", "yearly", "other"].map((k) => `<option ${k === p.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      <label>Billed by<select id="f_billed">${Object.keys(BILLED).map((k) => `<option value="${k}" ${k === p.billed_by ? "selected" : ""}>${BILLED[k]}</option>`).join("")}</select></label>
    </div>
    ${p.billed_by === "apple" ? `<p class="hint">Billed by Apple → cancel in Apple's subscription screen, at least 24h before the end. Your last safe day becomes 2 days before.</p>` : ""}
    <button id="addContract" class="btn primary">Add to ledger</button>
  </div>`;
}

function renderLedger() {
  const el = $("#ledger");
  if (!S.contracts.length) { el.innerHTML = `<p class="empty">No contracts yet. Read an email to add one.</p>`; return; }
  el.innerHTML = `<div class="rows">` + S.contracts.map((c) => {
    const [st, cls] = STATUS[c.status] || [c.status, ""];
    const nx = schedule(c, S.today)[0];
    return `<button class="row ${c.id === S.selected ? "sel" : ""}" data-id="${c.id}">
      <span class="svc">${esc(c.service)}<small>${BILLED[c.billed_by] || ""} · ${esc(money(c))}</small></span>
      <span class="dates"><small>ends</small>${fmt(c.end_date)}<small>last safe day ${fmt(lastSafeDay(c))}</small></span>
      <span class="st ${cls}">${st}<small>${nx ? "next: " + fmt(nx.date) : ""}</small></span>
    </button>`;
  }).join("") + `</div>`;
}

function renderThread() {
  const c = S.contracts.find((x) => x.id === S.selected);
  const th = $("#thread"), form = $("#replyForm"), quick = $("#quick");
  if (!c) {
    th.innerHTML = `<p class="empty">Pick a contract in the ledger.</p>`;
    form.hidden = quick.hidden = true;
    $("#threadTitle").textContent = "";
    $("#upcoming").innerHTML = `<li class="empty">—</li>`;
    $("#log").innerHTML = `<li class="empty">—</li>`;
    return;
  }
  $("#threadTitle").textContent = "· " + c.service;
  const msgs = S.threads[c.id] || [];
  th.innerHTML = msgs.map((m) => `<div class="msg ${m.who}"><div class="bubble">${esc(m.text)}</div><div class="when">${fmt(m.date)}${m.tag ? " · " + esc(m.tag) : ""}</div></div>`).join("");
  th.scrollTop = th.scrollHeight;
  const open = !["keeping", "closed"].includes(c.status);
  form.hidden = !open;
  quick.hidden = !open;
  const proof = c.status === "awaiting_proof";
  $("#replyText").placeholder = proof ? "Paste the cancellation email or the subscription-screen text…" : `Reply freely: "I'll do it this weekend", "keep it", "I cancelled"…`;
  $("#replyBtn").textContent = proof ? "Check proof" : "Send";
  const chips = proof
    ? [["Sample: cancellation email", `Subject: Your subscription has been cancelled\nYour ${c.service} subscription was cancelled. You can keep using it until ${long(c.end_date)}. You won't be charged again.`, "proof"],
       ["Sample: still-active screen", `${c.service}\nRenews ${long(c.end_date)}\n${money(c)}\nCancel Subscription`, "proof"],
       ["Actually, I'll keep it", "Actually, I'll keep it", "reply"]]
    : [["this weekend", "I'll deal with it this weekend", "reply"], ["not sure yet", "Hmm, not sure yet", "reply"], ["how do I cancel?", "How do I cancel this?", "reply"], ["next Monday", "I'll do it next Monday", "reply"], ["keep it", "I'll keep it, it's worth it", "reply"], ["I cancelled it", "I cancelled it already", "reply"]];
  quick.innerHTML = chips.map(([l, t, k]) => `<button class="chip" data-t="${esc(t)}" data-k="${k}">${esc(l)}</button>`).join("");
  const up = schedule(c, S.today);
  $("#upcoming").innerHTML = up.length ? up.map((u) => `<li><b>${fmt(u.date)}</b><span>${esc(u.why)}</span></li>`).join("") : `<li class="empty">No reminders${c.status === "closed" ? " — case closed" : c.status === "keeping" ? " — you're keeping it" : ""}.</li>`;
  const lg = S.logs[c.id] || [];
  $("#log").innerHTML = lg.length ? lg.slice().reverse().map((l) => `<li><span class="muted">${fmt(l.date)}</span> ${esc(l.text)}</li>`).join("") : `<li class="empty">—</li>`;
}

function render() { renderClock(); renderPending(); renderLedger(); renderThread(); save(); }

const say = (id, who, text, tag) => { (S.threads[id] ||= []).push({ who, text, date: S.today, tag }); };
const log = (id, lines) => { (S.logs[id] ||= []).push(...lines.map((text) => ({ text, date: S.today }))); };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = on ? "Reading…" : label; };

// ---------- actions ----------
$("#samples").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  $("#emailText").value = SAMPLES[+b.dataset.i].text(S.today);
});

$("#readEmail").addEventListener("click", async () => {
  const text = $("#emailText").value.trim(); if (!text) return;
  const btn = $("#readEmail"); busy(btn, true, "Read with AI");
  S.pending = null; renderPending();
  try {
    S.pending = await api("/api/read-email", { text, today: S.today });
    if (S.pending.trial_days > 0 && /free trial|trial ends|trial period/i.test(text) && S.pending.kind !== "none") S.pending.kind = "free_trial";
  }
  catch (e) { S.pending = { error: e.message }; }
  busy(btn, false, "Read with AI"); render();
});

$("#emailResult").addEventListener("click", (e) => {
  if (e.target.id !== "addContract") return;
  const end = $("#f_end").value;
  if (!isDate(end)) { alertBox("Set the end / renewal date first — the email didn't say it clearly."); return; }
  if (end <= S.today) { alertBox("That date is today or in the past."); return; }
  const c = {
    id: "c" + Date.now().toString(36),
    service: $("#f_service").value.trim() || "Subscription",
    end_date: end,
    price: parseFloat(String($("#f_price").value).replace(/[^\d.]/g, "")) || 0,
    currency: $("#f_cur").value.trim(),
    kind: $("#f_kind").value,
    trial_days: S.pending.trial_days || 0,
    billed_by: $("#f_billed").value,
    cancel_url: S.pending.cancel_url || "",
    status: "chasing",
    created: S.today,
    user_date: null, last_nudge: null, replied_since: true,
  };
  c.first_date = firstReminder(c, S.today);
  S.contracts.push(c);
  S.selected = c.id;
  const steps = cancelSteps(c);
  say(c.id, "agent", `Added ${c.service}. It ends ${fmt(c.end_date)}; your last safe day to cancel is ${fmt(lastSafeDay(c))}. If you stop it, it's in ${steps.where}. First reminder: ${fmt(c.first_date)}. You can reply anytime.`, "added");
  log(c.id, [`AI read the email: ${S.pending.reason}`, `Rule: first reminder ${fmt(c.first_date)}; last safe day ${fmt(lastSafeDay(c))}${c.billed_by === "apple" ? " (Apple: 24h before → 2 days)" : ""}.`]);
  S.pending = null; $("#emailText").value = "";
  render();
});

$("#ledger").addEventListener("click", (e) => {
  const r = e.target.closest(".row"); if (!r) return;
  S.selected = r.dataset.id; render();
});

async function handleSend(text, forceKind) {
  const c = S.contracts.find((x) => x.id === S.selected); if (!c || !text) return;
  const btn = $("#replyBtn");
  const proofMode = forceKind ? forceKind === "proof" : c.status === "awaiting_proof";
  say(c.id, "me", text);
  render();
  btn.disabled = true;
  try {
    if (proofMode) {
      const p = await api("/api/verify-proof", { text, contract: c });
      const out = applyProof(c, p);
      replace(out.contract); say(c.id, "agent", out.say, out.contract.status === "closed" ? "closed" : "not yet"); log(c.id, out.log);
    } else {
      let r, tag = "";
      try { r = await api("/api/read-reply", { text, today: S.today, weekday: weekdayName(S.today), contract: c }); }
      catch { r = fallbackReply(text); tag = "offline rules"; }
      const out = applyReply(c, r, S.today);
      replace(out.contract); say(c.id, "agent", out.say, tag); log(c.id, out.log.concat(r.fallback ? ["(AI unreachable — used offline keyword rules)"] : []));
    }
  } catch (e) {
    say(c.id, "agent", `I couldn't check that right now (${e.message}). Reminders stay on; try again.`, "error");
  }
  btn.disabled = false; render();
}
const replace = (c) => { S.contracts = S.contracts.map((x) => (x.id === c.id ? c : x)); };

$("#replyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("#replyText").value.trim(); $("#replyText").value = "";
  handleSend(t);
});
$("#quick").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  handleSend(b.dataset.t, b.dataset.k);
});

$("#nextDay").addEventListener("click", () => {
  S.today = addDays(S.today, 1);
  const out = tick(S.contracts, S.today);
  S.contracts = out.contracts;
  out.fired.forEach((f) => { say(f.id, "agent", f.say, f.kind); log(f.id, [`Clock: ${f.kind === "missed" ? "end date passed without cancel or keep" : "reminder fired"}.`]); });
  if (out.fired.length && !out.fired.some((f) => f.id === S.selected)) S.selected = out.fired[0].id;
  render();
});

$("#jump").addEventListener("click", () => {
  for (let i = 0; i < 400; i++) {
    const open = S.contracts.some((c) => ["chasing", "awaiting_proof"].includes(c.status));
    if (!open) break;
    S.today = addDays(S.today, 1);
    const out = tick(S.contracts, S.today);
    S.contracts = out.contracts;
    out.fired.forEach((f) => { say(f.id, "agent", f.say, f.kind); log(f.id, [`Clock: ${f.kind === "missed" ? "end date passed without cancel or keep" : "reminder fired"}.`]); });
    if (out.fired.length) { if (!out.fired.some((f) => f.id === S.selected)) S.selected = out.fired[0].id; break; }
  }
  render();
});

$("#reset").addEventListener("click", () => { S = fresh(); render(); });

function alertBox(msg) {
  const n = document.createElement("div"); n.className = "note bad"; n.textContent = msg;
  $("#emailResult").prepend(n); setTimeout(() => n.remove(), 4000);
}

renderSamples();
render();
