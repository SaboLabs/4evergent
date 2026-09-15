import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/engine.js";
import type { AgentIntent } from "@4evergent/shared";

const baseIntent = (overrides: Partial<AgentIntent> & { type: AgentIntent["type"] }): AgentIntent =>
  ({ type: "payment", asset: "XLM", destination: "GAAAA", amount: "10", reason: "test", ...overrides }) as AgentIntent;

test("allows payment within limits", () => {
  const engine = new PolicyEngine();
  const decision = engine.evaluate(baseIntent({ amount: "10" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("denies amount exceeding maxTxAmount", () => {
  const engine = new PolicyEngine({ maxTxAmount: { XLM: "100" } });
  const decision = engine.evaluate(baseIntent({ amount: "150" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /max_tx_amount/);
});

test("denies amount exceeding dailySpendingLimit", () => {
  const engine = new PolicyEngine({ dailySpendingLimit: { XLM: "500" }, maxTxAmount: { XLM: "1000" } });
  const decision = engine.evaluate(baseIntent({ amount: "600" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /daily/);
});

test("requires approval at threshold", () => {
  const engine = new PolicyEngine({ requireHumanApprovalForAmountAbove: "50" });
  const decision = engine.evaluate(baseIntent({ amount: "50" }), "GAGENT");
  assert.equal(decision.result, "requires_approval");
});

test("denies disallowed asset", () => {
  const engine = new PolicyEngine({ allowedAssets: ["XLM"] });
  const decision = engine.evaluate(baseIntent({ asset: "USDC" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /allowed_assets/);
});

test("denies disallowed destination", () => {
  const engine = new PolicyEngine({ allowedDestinations: ["GONLY"] });
  const decision = engine.evaluate(baseIntent({ destination: "GEVIL" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /allowed_destinations/);
});

test("denies tx type not in allowlist", () => {
  const engine = new PolicyEngine({ txTypeRestrictions: { payment: false } });
  const decision = engine.evaluate(baseIntent({}), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /not permitted/);
});

test("denies contract_call by default", () => {
  const engine = new PolicyEngine();
  const decision = engine.evaluate(
    { type: "contract_call", contractId: "CAAAA", function: "foo", args: [], reason: "t" },
    "GAGENT"
  );
  assert.equal(decision.result, "deny");
});

test("trustline with amount over limit is denied", () => {
  const engine = new PolicyEngine({ maxTxAmount: { native: "100" }, txTypeRestrictions: { payment: true, trustline: true } });
  const decision = engine.evaluate(
    { type: "trustline", assetCode: "T", issuer: "GAAAA", limit: "200", reason: "t" },
    "GAGENT"
  );
  assert.equal(decision.result, "deny");
});
