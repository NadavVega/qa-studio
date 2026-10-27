import { expect, test } from "vitest";
import type { AppMap } from "@qa/core";
import { checkRequirement, similarity } from "./checker";

const appMap: AppMap = {
  pages: [
    { name: "Orders", path: "/orders", fields: ["Order ID", "Total", "Order saved"] },
    { name: "Edit order", path: "/orders/:id/edit", fields: ["Save order"] },
  ],
};
const ctx = { appMap, existing: [{ id: "00000000-0000-4000-8000-000000000001", text: "The Total column must equal the sum of all six monthly quantities" }] };
const PO = "Product-owner decision";
const check = (text: string, source: string | null = PO) => checkRequirement({ text, source }, ctx);
const rules = (text: string, source: string | null = PO) => check(text, source).issues.map((i) => i.rule);

test("the two reference examples", () => {
  expect(check("Sales numbers should be correct")).toMatchObject({ status: "needs_work" });
  expect(rules("Sales numbers should be correct")).toEqual(expect.arrayContaining(["vague", "observable", "concrete"]));
  expect(check("Actual Sales is a unit count, not a monetary value")).toEqual({ status: "ready", issues: [] });
});

test("several rules in one: suggests a split", () => {
  for (const bad of [
    "The Total column must be a whole number and must not be negative",
    "Only signed-in users can open Orders; anyone else is sent to the login page",
    "After saving, the Orders table shows the new quantity and shows \"Order saved\"",
    "The Order ID column is sorted ascending. It also shows the product name",
  ]) expect(rules(bad)).toContain("split");
  expect(rules("Actual Sales and Discount columns are unit counts")).not.toContain("split");
  expect(rules("The Total column must equal the sum of Jan to Jun")).not.toContain("split");
});

test("vague words", () => {
  for (const bad of ["The Total column must be accurate", "Saving an order should work as expected on the Edit order page", "The Edit order page is user-friendly with 6 fields"]) {
    expect(rules(bad)).toContain("vague");
  }
  expect(rules("The Total column shows 1255 for ORD-001")).not.toContain("vague");
});

test("nothing observable: asks where it is seen", () => {
  const issue = check("Numbers must never be negative").issues.find((i) => i.rule === "observable");
  expect(issue?.fix).toContain("Orders");
  expect(rules("Quantities on the Edit order page must not be negative")).not.toContain("observable");
  expect(rules("The api returns actual_sales as an integer")).not.toContain("observable");
});

test("no concrete value: asks for one", () => {
  expect(rules("The Total column looks fine")).toContain("concrete");
  for (const good of ["The Total column shows 1255", "The Total column equals the sum of the six months", "The Order ID column is sorted ascending", "An empty Jan field is rejected"]) {
    expect(rules(good)).not.toContain("concrete");
  }
});

test("missing source", () => {
  expect(rules("The Total column shows 1255", null)).toContain("source");
  expect(rules("The Total column shows 1255", "  ")).toContain("source");
  expect(rules("The Total column shows 1255", "orders-spec.md, Orders table")).not.toContain("source");
});

test("out of scope: Not testable here, with the reason", () => {
  for (const [bad, reason] of [
    ["The Orders page loads within 2 seconds", "Performance"],
    ["The Orders table handles 500 concurrent users", "Load"],
    ["Passwords are encrypted with bcrypt", "Security"],
    ["The customer receives an email after Save order", "Email"],
    ["Saved quantities are stored in the database", "Backend"],
    ["Two users editing the same order at the same time see a conflict message", "Multi-user"],
  ] as const) {
    const r = check(bad);
    expect(r.status).toBe("not_testable");
    expect(r.issues.find((i) => i.rule === "out_of_scope")?.message).toContain(reason);
  }
  expect(check("The Cart page has a required Email field").status).not.toBe("not_testable");
});

test("page not in the app map: warns without blocking", () => {
  const r = check("The Shipping page shows 6 month columns");
  expect(r.issues).toEqual([expect.objectContaining({ rule: "unknown_page", level: "warn" })]);
  expect(r.status).toBe("ready");
  expect(rules("The Orders page shows 6 month columns")).not.toContain("unknown_page");
  expect(checkRequirement({ text: "The Shipping page shows 6 month columns", source: PO }, { appMap: null, existing: [] }).issues).toEqual([]);
});

test("near-duplicate links to the existing requirement", () => {
  const issue = check("The Total column must equal the sum of the six monthly quantities.").issues.find((i) => i.rule === "duplicate");
  expect(issue?.requirementId).toBe(ctx.existing[0]!.id);
  expect(rules("The Total column shows 1255 for ORD-001")).not.toContain("duplicate");
  expect(similarity("A b c", "a, B. c")).toBe(1);
});
