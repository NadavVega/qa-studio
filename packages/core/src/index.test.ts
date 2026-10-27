import { expect, test } from "vitest";
import { AuthConfig, Verdict } from "./index";

test("infra_failure is a distinct verdict, never a defect", () => {
  expect(Verdict.parse("infra_failure")).toBe("infra_failure");
  expect(() => Verdict.parse("defect")).toThrow();
});

test("authConfig accepts env var names only, never credential values", () => {
  expect(AuthConfig.parse({ userEnv: "APP_USER" })).toEqual({ userEnv: "APP_USER" });
  expect(() => AuthConfig.parse({ password: "hunter2" })).toThrow();
  expect(() => AuthConfig.parse({ passwordEnv: "hunter2" })).toThrow();
});
