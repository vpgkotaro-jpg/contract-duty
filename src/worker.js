// Contract Duty (契約当番) — API worker.
// The language model only READS (emails, replies, proof). Every date and every
// "stop chasing" decision is computed by deterministic code in public/agent.js.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    is_contract: { type: "boolean" },
    reason: { type: "string" },
    service: { type: "string" },
    price: { type: "number" },
    currency: { type: "string" },
    kind: { type: "string", enum: ["free_trial", "monthly", "yearly", "other", "none"] },
    trial_days: { type: "number" },
    end_date: { type: "string" },
    billed_by: { type: "string", enum: ["apple", "google_play", "direct", "unknown"] },
    cancel_url: { type: "string" },
  },
  required: ["is_contract", "reason", "service", "price", "currency", "kind", "trial_days", "end_date", "billed_by", "cancel_url"],
};

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["keep", "cancel_later", "claims_cancelled", "undecided", "help", "other"] },
    when_type: { type: "string", enum: ["none", "absolute", "relative_days", "weekday", "weekend", "tonight", "tomorrow"] },
    when_date: { type: "string" },
    when_days: { type: "number" },
    when_weekday: { type: "string", enum: ["", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
    when_next_week: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["intent", "when_type", "summary"],
};

const PROOF_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    service_matches: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["verified", "service_matches", "reason"],
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function parseModelOutput(r) {
  let out = r && (r.response ?? r.result ?? r);
  if (typeof out === "string") {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("model returned no JSON");
    out = JSON.parse(m[0]);
  }
  if (!out || typeof out !== "object") throw new Error("model returned no object");
  return out;
}

async function ask(env, system, user, schema) {
  const r = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: 600,
    temperature: 0.1,
  });
  return parseModelOutput(r);
}

const clip = (s, n) => String(s || "").slice(0, n);

async function readEmail(env, body) {
  const system = `You read ONE email for a person who wants to stop forgetting to cancel subscriptions.
Decide if it is about a contract the person already has (a free trial that will turn into a charge, an auto-renewing plan, a renewal notice). Marketing offers for things the person has NOT signed up for are NOT contracts.
Extract only what the email states. Never guess a price or date that is not written; use 0 for an unknown price and "" for an unknown date.
end_date = the date the trial ends or the plan renews / charges next, as YYYY-MM-DD. Resolve dates without a year using today's date (${body.today}) so the date is in the future.
billed_by: "apple" if billed through Apple / App Store / iTunes, "google_play" if Google Play, "direct" if the company bills a card itself, otherwise "unknown".
kind: "free_trial" whenever the email is about a free trial that will turn into a paid plan (even if the paid plan is monthly or yearly); "monthly" or "yearly" for a paid plan that renews; "other"; or "none" (not a contract). trial_days = length of the free trial if stated, else 0.
cancel_url: a cancellation or account URL written in the email, else "".
reason: one short sentence on why you decided.`;
  return ask(env, system, `EMAIL:\n${clip(body.text, 6000)}`, EMAIL_SCHEMA);
}

async function readReply(env, body) {
  const c = body.contract || {};
  const system = `You read a person's free-text reply to a reminder about cancelling "${clip(c.service, 80)}" (deadline ${c.end_date}). Today is ${body.today} (${body.weekday}).
Classify the intent:
- keep: they decided to keep paying
- cancel_later: they will cancel or decide at some time (extract when)
- claims_cancelled: they say they already cancelled
- undecided: they are unsure / thinking about it, no time given
- help: they ask how to cancel or what it costs
- other
Extract WHEN they said they will act, without computing calendar math for weekdays:
- "absolute" + when_date (YYYY-MM-DD) for an explicit date
- "relative_days" + when_days for "in 3 days"
- "tomorrow", "tonight"
- "weekday" + when_weekday, and when_next_week=true only if they said "next <weekday>"
- "weekend" for "this weekend" / "on the weekend"
- "none" if no time.
summary: one short sentence restating what they said, in English.`;
  return ask(env, system, `REPLY:\n${clip(body.text, 1500)}`, REPLY_SCHEMA);
}

async function verifyProof(env, body) {
  const c = body.contract || {};
  const system = `You check whether a pasted text (a cancellation email or the text of a subscription screen) shows that the subscription "${clip(c.service, 80)}" is cancelled or will not renew.
verified=true only if the text clearly says the subscription was cancelled, ended, expired, or will not renew. A text that only says how to cancel, or says the plan is active / will renew, is NOT proof.
service_matches=true if the text is about "${clip(c.service, 80)}" (or clearly the same product).
reason: one short sentence quoting or paraphrasing the line that decided it.`;
  return ask(env, system, `TEXT:\n${clip(body.text, 4000)}`, PROOF_SCHEMA);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad JSON" }, 400);
    }
    try {
      if (url.pathname === "/api/read-email") return json(await readEmail(env, body));
      if (url.pathname === "/api/read-reply") return json(await readReply(env, body));
      if (url.pathname === "/api/verify-proof") return json(await verifyProof(env, body));
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "ai_failed", detail: String(e && e.message || e) }, 502);
    }
  },
};
