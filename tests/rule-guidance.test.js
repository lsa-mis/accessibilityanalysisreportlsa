const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const RuleGuidance = require("../rule-guidance.js");
const { rules } = require(path.join(__dirname, "..", "data", "rules.json"));

const AUDIENCES = Object.keys(RuleGuidance.audiences);
const FIXED_IN = ["Page content", "Site theme", "Uploaded documents"];

test("every rule in data/rules.json has valid guidance", () => {
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    const id = String(rule.rule_id);
    const g = RuleGuidance.rules[id];
    assert.ok(g, `missing guidance for rule ${id}`);
    assert.ok(AUDIENCES.includes(g.audience), `rule ${id}: bad audience ${g.audience}`);
    assert.ok(FIXED_IN.includes(g.fixedIn), `rule ${id}: bad fixedIn ${g.fixedIn}`);
    assert.ok(typeof g.plain === "string" && g.plain.trim() && g.plain.length <= 60, `rule ${id}: bad plain`);
    assert.ok(typeof g.why === "string" && g.why.trim(), `rule ${id}: empty why`);
    assert.ok(Array.isArray(g.fix) && g.fix.length >= 1 && g.fix.length <= 3, `rule ${id}: fix needs 1-3 steps`);
    for (const step of g.fix) assert.ok(typeof step === "string" && step.trim(), `rule ${id}: empty fix step`);
    for (const text of [g.plain, g.why, ...g.fix]) assert.ok(!/<[a-z]/i.test(text), `rule ${id}: contains HTML`);
  }
});
