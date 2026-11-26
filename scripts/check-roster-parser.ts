import assert from "node:assert/strict";
import { parseRosterPaste } from "../lib/parse-roster-paste.ts";

const result = parseRosterPaste([
  "Name, Email, Phone, Gender",
  '"Ada Lovelace" <ada@example.com>, 555-0100',
  "bob@example.com (Bob Ross)",
  "charlie@example.com",
  "not an email address",
  "CAROL@example.com\tCarol King\t555-0101",
  '"Jane Doe"\tjane.doe@example.com\t555-1234\tF',
].join("\n"));

assert.equal(result.players.length, 5);
assert.deepEqual(result.players.map((player) => player.email), [
  "ada@example.com",
  "bob@example.com",
  "charlie@example.com",
  "carol@example.com",
  "jane.doe@example.com",
]);
assert.equal(result.unparsedLines.includes("not an email address"), true);
assert.equal(result.unparsedLines.includes("charlie@example.com"), false);
const jane = result.players.find((player) => player.email === "jane.doe@example.com");
assert.equal(jane?.name, "Jane Doe");
console.log("roster parser self-check passed");
