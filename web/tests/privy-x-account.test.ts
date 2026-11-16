/** iPhone app Connect X (app/api/x/privy): the X account Privy verified is read from the user's linked accounts. */
import { describe, expect, it } from "vitest";
import { userFromLinkedAccounts } from "../lib/server/privyAuth";

const DID = "did:privy:abcdefgh1234";

describe("userFromLinkedAccounts: X", () => {
  it("reads the twitter_oauth subject (X user id) and handle", () => {
    const u = userFromLinkedAccounts(DID, [
      { type: "email", address: "Pilot@Example.com" },
      { type: "twitter_oauth", subject: "1234567890", username: "@disciplevip", name: "DISCIPLE" },
    ]);
    expect(u?.x).toEqual({ id: "1234567890", username: "disciplevip" });
    expect(u?.emails).toEqual(["pilot@example.com"]);
  });
  it("no X linked → null", () => {
    expect(userFromLinkedAccounts(DID, [{ type: "google_oauth", email: "a@b.co" }])?.x).toBeNull();
  });
});
