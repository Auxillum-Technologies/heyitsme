import { describe, expect, it } from "vitest";
import { upgradeFootnote } from "./upgradeFootnote";

describe("upgrade dialog footnote", () => {
  it("tells a buyer who picks an auto-renew channel that the plan renews by itself, with no renew-by-hand step", () => {
    const text = upgradeFootnote("maya", ["maya"]);
    expect(text).toContain("Renews by itself each month with Maya.");
    expect(text).toContain("Cancel any time from Billing.");
    expect(text).not.toMatch(/Renew from Billing/);
  });

  it("tells a buyer who pays one month to renew from Billing", () => {
    for (const [channel, autoRenew] of [["gcash", ["maya"]], ["maya", []], [undefined, ["maya"]]] as const) {
      const text = upgradeFootnote(channel, autoRenew);
      expect(text).toContain("Renew from Billing before it ends.");
      expect(text).not.toMatch(/by itself/);
    }
  });
});
