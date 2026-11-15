import assert from "node:assert/strict";
import { resolveWhen, schedule, firstReminder, lastSafeDay, applyReply, applyProof, tick, addDays } from "../public/agent.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
// 2026-11-15 is a Sunday
t("weekend said on Sunday -> next Saturday", () => assert.equal(resolveWhen({ when_type: "weekend" }, "2026-11-15").date, "2026-11-21"));
t("weekend said on Wednesday -> this Saturday", () => assert.equal(resolveWhen({ when_type: "weekend" }, "2026-11-18").date, "2026-11-21"));
t("weekend said on Saturday -> Sunday", () => assert.equal(resolveWhen({ when_type: "weekend" }, "2026-11-21").date, "2026-11-22"));
t("next Monday said on Sunday -> 11/16 (weeks start Monday)", () => assert.equal(resolveWhen({ when_type: "weekday", when_weekday: "monday", when_next_week: true }, "2026-11-15").date, "2026-11-16"));
t("next Monday said on Wednesday -> 11/23", () => assert.equal(resolveWhen({ when_type: "weekday", when_weekday: "monday", when_next_week: true }, "2026-11-18").date, "2026-11-23"));
t("coming Friday said on Friday -> a week later", () => assert.equal(resolveWhen({ when_type: "weekday", when_weekday: "friday" }, "2026-11-20").date, "2026-11-27"));
const apple = { service: "M", kind: "free_trial", trial_days: 30, end_date: "2026-12-01", billed_by: "apple", status: "chasing", created: "2026-11-15" };
apple.first_date = firstReminder(apple, "2026-11-15");
t("30-day trial first reminder 14 days before", () => assert.equal(apple.first_date, "2026-11-17"));
t("Apple last safe day = end - 2", () => assert.equal(lastSafeDay(apple), "2026-11-29"));
t("Apple schedule never goes past last safe day", () => {
  const s = schedule(apple, "2026-11-15").map((x) => x.date);
  assert.deepEqual(s, ["2026-11-17", "2026-11-28", "2026-11-29"]);
});
t("3-day trial -> next morning", () => assert.equal(firstReminder({ kind: "free_trial", trial_days: 3, end_date: "2026-11-18" }, "2026-11-15"), "2026-11-16"));
t("yearly -> 30 days before", () => assert.equal(firstReminder({ kind: "yearly", end_date: "2026-12-25" }, "2026-11-15"), "2026-11-25"));
t("keep stops reminders", () => { const o = applyReply(apple, { intent: "keep", when_type: "none" }, "2026-11-15"); assert.equal(o.contract.status, "keeping"); assert.equal(schedule(o.contract, "2026-11-15").length, 0); });
t("claim of cancel does not close", () => { const o = applyReply(apple, { intent: "claims_cancelled", when_type: "none" }, "2026-11-15"); assert.equal(o.contract.status, "awaiting_proof"); assert.ok(schedule(o.contract, "2026-11-15").length > 0); });
t("date after last safe day is pulled back", () => { const o = applyReply(apple, { intent: "cancel_later", when_type: "absolute", when_date: "2026-11-30" }, "2026-11-15"); assert.equal(o.contract.user_date, "2026-11-29"); });
t("proof for another service does not close", () => assert.equal(applyProof({ ...apple, status: "awaiting_proof" }, { verified: true, service_matches: false, reason: "x" }).contract.status, "awaiting_proof"));
t("verified proof closes", () => assert.equal(applyProof({ ...apple, status: "awaiting_proof" }, { verified: true, service_matches: true, reason: "x" }).contract.status, "closed"));
t("no reply -> follow-up next morning", () => {
  let cs = [{ ...apple }]; let r = tick(cs, "2026-11-17"); assert.equal(r.fired.length, 1);
  r = tick(r.contracts, "2026-11-18"); assert.equal(r.fired.length, 1, "follow-up fires");
});
t("missed after end date", () => { const r = tick([{ ...apple }], "2026-12-02"); assert.equal(r.contracts[0].status, "missed"); });
console.log(`${n} tests passed`);
