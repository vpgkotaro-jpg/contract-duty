// Deterministic part of the agent: dates, reminder schedule, state changes.
// The language model never picks a date or closes a case on its own; it only
// returns what it read, and these functions decide what happens next.

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const toUTC = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
};
const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d, n) => fromUTC(toUTC(d) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000); // b - a
export const weekdayIndex = (d) => new Date(toUTC(d)).getUTCDay();
export const weekdayName = (d) => WEEKDAYS[weekdayIndex(d)];
export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toUTC(s));

export function fmt(d) {
  if (!isDate(d)) return "—";
  return new Date(toUTC(d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Apple asks you to cancel at least 24 hours before the renewal, so the last
// safe day for an Apple-billed plan is two days before the end date.
export function lastSafeDay(c) {
  if (isDate(c.safe_date)) return c.safe_date;
  return c.billed_by === "apple" ? addDays(c.end_date, -2) : addDays(c.end_date, -1);
}

// When the first reminder goes out depends on the kind of contract.
export function firstReminder(c, today) {
  const end = c.end_date;
  let d;
  if (c.kind === "free_trial") {
    const len = Number(c.trial_days) || diffDays(today, end);
    if (len >= 30) d = addDays(end, -14);
    else if (len >= 8) d = addDays(end, -7);
    else d = addDays(today, 1);
  } else if (c.kind === "yearly") d = addDays(end, -30);
  else d = addDays(end, -3);
  return d < today ? today : d;
}

export function firstReminderRule(c, today) {
  if (c.kind === "free_trial") {
    const len = Number(c.trial_days) || diffDays(today, c.end_date);
    if (len >= 30) return "trial of 30+ days: 14 days before the end";
    if (len >= 8) return "trial of 8–29 days: 7 days before the end";
    return "trial of 7 days or less: the next morning";
  }
  if (c.kind === "yearly") return "yearly plan: 30 days before renewal";
  return "monthly plan: 3 days before renewal";
}

// Build the upcoming reminders. Each item: {date, why}.
export function schedule(c, today) {
  if (["keeping", "closed", "missed"].includes(c.status)) return [];
  const last = lastSafeDay(c);
  const items = new Map();
  const put = (date, why) => {
    if (!isDate(date) || date < today || date > last) return;
    if (!items.has(date)) items.set(date, why);
  };
  if (c.user_date) put(c.user_date, "the day you said");
  else put(c.first_date, "first reminder — " + firstReminderRule(c, c.created));
  if (c.last_nudge && !c.replied_since && addDays(c.last_nudge, 1) >= today) put(addDays(c.last_nudge, 1), "no reply yet — next morning");
  put(addDays(c.end_date, -3), "3 days before the end");
  if (c.billed_by === "apple") put(last, "last safe day for Apple (24h rule)");
  else {
    put(addDays(c.end_date, -1), "the day before");
    put(c.end_date, "the last day");
  }
  return [...items.entries()].map(([date, why]) => ({ date, why })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Turn the model's reading of "when" into a calendar date.
export function resolveWhen(r, today) {
  const t = r.when_type;
  if (t === "absolute" && isDate(r.when_date)) return { date: r.when_date, rule: "the date you gave" };
  if (t === "relative_days" && Number(r.when_days) > 0) return { date: addDays(today, Math.round(r.when_days)), rule: `${Math.round(r.when_days)} days from today` };
  if (t === "tomorrow") return { date: addDays(today, 1), rule: "tomorrow" };
  if (t === "tonight") return { date: today, rule: "tonight (today)" };
  const w = weekdayIndex(today);
  if (t === "weekend") {
    if (w === 6) return { date: addDays(today, 1), rule: "said on a Saturday → Sunday" };
    if (w === 0) return { date: addDays(today, 6), rule: "said on a Sunday → the weekend still ahead is next Saturday" };
    return { date: addDays(today, 6 - w), rule: "this Saturday" };
  }
  if (t === "weekday" && WEEKDAYS.includes(r.when_weekday)) {
    const target = WEEKDAYS.indexOf(r.when_weekday);
    if (r.when_next_week) {
      // next calendar week (weeks start on Monday)
      const toNextMonday = ((8 - w) % 7) || 7;
      const nextMonday = addDays(today, toNextMonday);
      const offset = (target + 6) % 7; // Monday=0 … Sunday=6
      return { date: addDays(nextMonday, offset), rule: `next week's ${r.when_weekday}` };
    }
    let ahead = (target - w + 7) % 7;
    if (ahead === 0) ahead = 7;
    return { date: addDays(today, ahead), rule: `the coming ${r.when_weekday}` };
  }
  return null;
}

const money = (c) => (c.price ? `${c.currency || ""} ${c.price}`.trim() : "the price (not stated in the email)");

export function cancelSteps(c) {
  if (c.billed_by === "apple")
    return {
      where: "Apple subscriptions (not the app's own website)",
      steps: ["iPhone: Settings → your name → Subscriptions", `Tap ${c.service} → Cancel Subscription`, "Check the screen now says when it expires"],
      url: "https://apps.apple.com/account/subscriptions",
    };
  if (c.billed_by === "google_play")
    return {
      where: "Google Play subscriptions",
      steps: ["Play Store → profile icon → Payments & subscriptions → Subscriptions", `Pick ${c.service} → Cancel subscription`, "Keep the cancellation email Google sends"],
      url: "https://play.google.com/store/account/subscriptions",
    };
  if (c.billed_by === "direct")
    return {
      where: `${c.service}'s own account page`,
      steps: ["Sign in on the service's website", "Account / Billing → Cancel plan", "Keep the confirmation email"],
      url: c.cancel_url || "",
    };
  return {
    where: "unknown — check who charges you first",
    steps: ["Look at the receipt sender or your card statement", "If it says Apple or Google Play, cancel there", "Otherwise cancel on the service's account page"],
    url: c.cancel_url || "",
  };
}

// Apply the model's reading of a reply. Returns {contract, say, log}.
export function applyReply(c0, r, today) {
  const c = { ...c0, replied_since: true };
  const last = lastSafeDay(c);
  const log = [`AI read: intent = ${r.intent}${r.when_type && r.when_type !== "none" ? `, when = ${r.when_type}${r.when_type === "weekday" && r.when_weekday ? " " + r.when_weekday : ""}${r.when_type === "weekday" && r.when_next_week ? " (next week)" : ""}${r.when_type === "absolute" && r.when_date ? " " + r.when_date : ""}${r.when_type === "relative_days" && r.when_days ? " +" + r.when_days + "d" : ""}` : ""}`];
  let say;
  if (r.intent === "keep") {
    c.status = "keeping";
    c.user_date = null;
    say = `Okay, you're keeping ${c.service}. I'll stop reminding you. It will charge ${money(c)} on ${fmt(c.end_date)}.`;
    log.push("Rule: 'keep' stops all reminders.");
  } else if (r.intent === "claims_cancelled") {
    c.status = "awaiting_proof";
    say = `Thanks! Before I stop, paste the cancellation email or the text on the subscription screen (for example "expires on …"). Until then, the reminders stay on.`;
    log.push("Rule: a claim alone doesn't close the case; proof is required.");
  } else if (r.intent === "cancel_later" || (r.intent === "undecided" && r.when_type && r.when_type !== "none")) {
    const w = resolveWhen(r, today);
    if (w) {
      c.status = "chasing";
      if (w.date > last) {
        c.user_date = last;
        say = `${fmt(w.date)} is after your last safe day (${fmt(last)}). I'll remind you on ${fmt(last)} instead — after that it may charge ${money(c)}.`;
        log.push(`Rule: "${w.rule}" → ${w.date}, later than the last safe day → moved to ${last}.`);
      } else {
        c.user_date = w.date;
        say = `Got it. Next reminder: ${fmt(w.date)} morning (${w.rule}). The deadline reminders stay as they are.`;
        log.push(`Rule: "${w.rule}" → ${w.date}.`);
      }
    } else {
      say = `When do you want to do it? You can say "tomorrow", "this weekend" or a date. Last safe day: ${fmt(last)}.`;
      log.push("Rule: no time given → ask for one, keep the schedule.");
    }
  } else if (r.intent === "undecided") {
    c.status = "chasing";
    const s = cancelSteps(c);
    say = `If you keep it, it charges ${money(c)} on ${fmt(c.end_date)}. If you stop, do it by ${fmt(last)} in ${s.where}. Tell me when you'll decide, or just "keep" / "I cancelled".`;
    log.push("Rule: undecided → send the cost and the steps, keep the schedule.");
  } else if (r.intent === "help") {
    const s = cancelSteps(c);
    say = `Cancel in ${s.where}: ${s.steps.join(" → ")}.${s.url ? " Link: " + s.url : ""} Last safe day: ${fmt(last)}.`;
    log.push("Rule: help → steps for where it is billed.");
  } else {
    say = `I didn't catch a decision. Reply "keep", "I cancelled", or when you'll do it. Last safe day: ${fmt(last)}.`;
    log.push("Rule: no decision → keep the schedule.");
  }
  return { contract: c, say, log };
}

export function applyProof(c0, p) {
  const c = { ...c0 };
  if (p.verified && p.service_matches) {
    c.status = "closed";
    c.user_date = null;
    return { contract: c, say: `Confirmed: ${p.reason} I've closed ${c.service} and stopped all reminders.`, log: ["AI read: proof verified, same service.", "Rule: verified proof closes the case."] };
  }
  const why = !p.service_matches ? "it doesn't look like it's about " + c.service : "it doesn't show the plan was cancelled";
  return { contract: c, say: `I can't close it yet — ${why} (${p.reason}). Reminders stay on until I see proof.`, log: [`AI read: verified=${p.verified}, same service=${p.service_matches}.`, "Rule: no proof → keep chasing."] };
}

// Move the clock forward one day; returns reminder messages that fire today.
export function tick(contracts, today) {
  const fired = [];
  const next = contracts.map((c0) => {
    const c = { ...c0 };
    if (["keeping", "closed", "missed"].includes(c.status)) return c;
    if (today > c.end_date) {
      c.status = "missed";
      fired.push({ id: c.id, say: `${c.service} renewed on ${fmt(c.end_date)} and may have charged ${money(c)}. I'm marking it as missed. You can still cancel to avoid the next charge.`, kind: "missed" });
      return c;
    }
    const due = schedule(c, today).find((s) => s.date === today);
    if (due) {
      const s = cancelSteps(c);
      const left = diffDays(today, lastSafeDay(c));
      fired.push({
        id: c.id,
        kind: "reminder",
        say: `Reminder (${due.why}): ${c.service} ends ${fmt(c.end_date)}${c.price ? `, then ${money(c)}` : ""}. ${left <= 0 ? "Today is your last safe day." : `${left} day${left === 1 ? "" : "s"} until your last safe day.`} To stop it: ${s.where}. Keep or stop?`,
      });
      c.last_nudge = today;
      c.replied_since = false;
      if (c.user_date && c.user_date <= today) c.user_date = null;
    }
    return c;
  });
  return { contracts: next, fired };
}

// Offline fallbacks, used only if the AI endpoint is unreachable. Labelled in the UI.
export function fallbackReply(text) {
  const t = text.toLowerCase();
  const r = { intent: "other", when_type: "none", summary: text, fallback: true };
  if (/\b(keep|stay|continue|worth it)\b/.test(t)) r.intent = "keep";
  else if (/(cancel+ed|already (stopped|cancel)|i stopped|done it|did it)/.test(t)) r.intent = "claims_cancelled";
  else if (/(how|where).*(cancel|stop)|steps|price|cost/.test(t)) r.intent = "help";
  else if (/(not sure|unsure|thinking|maybe|don't know|dunno)/.test(t)) r.intent = "undecided";
  if (/weekend/.test(t)) Object.assign(r, { intent: r.intent === "other" ? "cancel_later" : r.intent, when_type: "weekend" });
  else if (/tomorrow/.test(t)) Object.assign(r, { intent: r.intent === "other" ? "cancel_later" : r.intent, when_type: "tomorrow" });
  else if (/tonight|later today/.test(t)) Object.assign(r, { intent: r.intent === "other" ? "cancel_later" : r.intent, when_type: "tonight" });
  else {
    const m = t.match(/(next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
    if (m) Object.assign(r, { intent: r.intent === "other" ? "cancel_later" : r.intent, when_type: "weekday", when_weekday: m[2], when_next_week: !!m[1] });
  }
  return r;
}
