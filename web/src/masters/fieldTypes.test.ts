import { describe, expect, test } from "vitest";
import { guessFieldType } from "./fieldTypes";

describe("guessing what a field holds from its name", () => {
  test.each([
    ["Medical certificate", "document"], ["Driving licence", "document"], ["Contract", "document"],
    ["Licence number", "text"], ["Union card number", "text"], ["Licence class", "text"],
    ["Expiry date", "date"], ["Photo", "image"], ["Inspection photos", "files"],
    ["Mobile", "phone"], ["Work e-mail", "email"], ["Has a fridge", "boolean"], ["Years of experience", "number"], ["Notes", "long_text"],
    ["Blood group", "text"],
  ])("%s → %s", (name, type) => { expect(guessFieldType(name)?.type).toBe(type); });
  test("a document that expires says so", () => { expect(guessFieldType("Medical certificate")?.withExpiry).toBe(true); });
  test("nothing typed, no guess", () => { expect(guessFieldType("  ")).toBeUndefined(); });
});
