# Contract Duty (契約当番)

**An AI agent that chases your subscription cancellation deadlines — and doesn't stop until you're actually done.**

Live demo: https://contract-duty.furatto-island.workers.dev

Reminder apps tell you a free trial ends on a date. Then you see the notification, think "later", and pay anyway. Contract Duty is built for the "later":

1. **Paste a subscription email.** The AI tells a real contract (free trial, auto-renewal) from a marketing email, and reads the service, price, end date and *who bills you* (Apple, Google Play, or the company itself). You check the fields before anything is saved.
2. **It plans the reminders.** The schedule is computed by code, not by the model: first reminder depends on the contract (30+ day trial → 14 days before; 8–29 days → 7 days before; ≤7 days → next morning; monthly → 3 days before; yearly → 30 days before), then 3 days before, the day before and the last day. Apple-billed plans must be cancelled at least 24 hours before renewal, so their last reminder is 2 days before the end.
3. **Reply like a human.** "I'll deal with it this weekend", "not sure yet", "how do I cancel?", "keep it". The AI reads the intent and the time phrase; code turns it into a date (said on a Sunday, "this weekend" means *next* Saturday, not the few hours left today). If the date you name is after your last safe day, it moves the reminder earlier and tells you why.
4. **"I cancelled" is not enough.** It asks for the cancellation email or the subscription-screen text, and the AI checks it. A screen that still says "Renews …" is rejected; only real proof closes the case.
5. **It keeps a record, and the record changes what it does.** Every decision is saved: what you stopped, what got charged, how many times you said "later", and why you cancelled or kept it. If your record shows you usually say "later" twice or more, or a charge slipped through, new contracts get their first reminder 3 days earlier.
6. **You stay in charge.** It never cancels anything or logs in anywhere. It only makes sure you decide before the money moves.

A demo clock (**Next day**, **Next reminder**) lets you fast-forward through a trial in a minute.

## Why an agent, not a reminder app

A reminder app runs one task: send a notification on a date. Contract Duty is given a goal, *you decide before the money moves*, and works toward it over days:

- **It acts without being asked.** If you don't reply to a reminder, it asks again the next morning.
- **It re-plans.** "This weekend" moves the next reminder to Saturday; a plan that's later than your last safe day gets pulled earlier, with the reason.
- **It checks the result.** "I cancelled" is a claim, not a result. It asks for proof and rejects a screen that still says "Renews".
- **It learns from your record.** Past decisions change the timing for new contracts.
- **It knows when to stop**, and it shows every step and the rule behind it.

## Who decides what

| AI (Llama 3.3 70B on Workers AI) reads | Code decides | You decide |
|---|---|---|
| Is this email a contract? Price, end date, billed by | Every reminder date, the last safe day, Apple's 24h rule | Keep or cancel |
| What your free-text reply means, and *when* you said you'd act | Turning "this weekend" / "next Monday" into a date | Pressing the cancel button |
| Whether pasted text proves the cancellation | When to stop chasing (only after verified proof or "keep") | Confirming the fields the AI read |
| | Starting 3 days earlier when your record says you procrastinate | Why you cancelled or kept it |

The model never picks a date and never closes a case by itself. Every decision is written to the **Agent log** next to the conversation.

## How it's built

- `src/worker.js` — Cloudflare Worker. Three endpoints (`/api/read-email`, `/api/read-reply`, `/api/verify-proof`), each a Workers AI call with a JSON schema so the model returns structured fields only.
- `public/agent.js` — deterministic agent logic: schedule, date resolution, state changes. Shared by the browser and the tests.
- `public/app.js`, `index.html`, `style.css` — vanilla JS UI. No framework, no build step.
- `tests/agent.test.mjs` — 18 tests (weekend/weekday rules, Apple's last safe day, "claim ≠ proof", follow-up after no reply, missed deadline). Run: `node tests/agent.test.mjs`.

Run locally: `npx wrangler dev` (needs a Cloudflare account for Workers AI). Deploy: `npx wrangler deploy`.

## Privacy

Contracts and conversations are stored only in your browser (localStorage). Text you send to the AI goes to Cloudflare Workers AI to be read and is not stored by this app. Don't paste card numbers or passwords. The sample emails are fictional services.

## Limits (honest list)

- The record lives in one browser. Pooling reasons across users, with permission and only the reason plus the type of service (no names or emails), is a plan, not built.
- It doesn't connect to Gmail or send push notifications yet: you paste emails and use the demo clock. Email forwarding and LINE/push notifications are the next step.
- Not tested with real users yet.
- The model can misread an email, which is why you confirm the fields before saving.

## Background and AI disclosure

The idea came from my own forgotten cancellations (four subscriptions I paid for after meaning to cancel). I pitched the concept, without code, at an AI-agent ideathon in Japan on Nov 6, 2026. **All code in this repository was written during IceHacks on Nov 15, 2026.**

Significant AI use: the code was written with Claude Code (Anthropic's coding assistant) under my direction — I set the rules (reminder timing, Apple's 24h rule, "proof before closing", the weekend rule) and tested the flows; the assistant wrote most of the code. At runtime, the app uses Llama 3.3 70B on Cloudflare Workers AI to read emails and replies.

— Kotaro Kurosaki (team NEXUS)
