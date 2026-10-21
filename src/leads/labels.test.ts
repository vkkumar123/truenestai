import { describe, expect, it } from "vitest";
import { BUDGET_BAND_LABELS, LEAD_STATUS_LABELS, REQUEST_TYPE_LABELS } from "./labels";
import { BUDGET_BANDS } from "./validation";

describe("labels", () => {
  it("covers every budget band in order", () => {
    expect(Object.keys(BUDGET_BAND_LABELS)).toEqual([...BUDGET_BANDS]);
  });
  it("covers statuses and request types", () => {
    expect(Object.keys(LEAD_STATUS_LABELS)).toHaveLength(5);
    expect(Object.keys(REQUEST_TYPE_LABELS)).toEqual(["verification", "buyer_assistance"]);
  });
});
