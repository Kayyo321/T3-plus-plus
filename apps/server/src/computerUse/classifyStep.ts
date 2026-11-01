import type { ComputerUseActInput, ComputerUseSensitivity } from "@t3tools/contracts";

const CREDENTIAL_FIELD =
  /\b(pass(word|code|phrase)|secret|api[ _-]?key|access[ _-]?token|one[ -]time|otp|2fa|mfa|cvv|cvc|security code|card number|ssn|social security)\b/i;

const SECRET_TEXT =
  /(\bsk-[a-z0-9-]{16,}|\bgh[pousr]_[a-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abp]-[a-z0-9-]{10,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/i;

const PURCHASE =
  /\b(buy|purchase|check ?out|place (your |the )?order|pay( now)?|payment|subscribe|add to (cart|basket)|confirm order)\b/i;

const MESSAGE = /\b(send|post|publish|tweet|reply|comment|email|submit)\b/i;

const DELETE = /\b(delete|remove|erase|wipe|destroy|uninstall|discard|empty (the )?trash)\b/i;

/** A payment card number: 13 to 19 digits that pass the Luhn check. */
function isCardNumber(text: string): boolean {
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    const doubled = index % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

/**
 * Finds a step that needs a person. It reads what the agent says it is doing and what it would
 * type, so it catches a slip, not a determined agent: isolation is the real boundary, which is
 * why a virtual display and the app's browser are the only targets.
 */
export function classifyStep(input: ComputerUseActInput): ComputerUseSensitivity | null {
  if (input.sensitivity === "credentials") return "credentials";
  const described = [input.intent, input.locator ?? "", input.url ?? ""].join(" ");
  if (input.action === "type") {
    const text = input.text ?? "";
    if (CREDENTIAL_FIELD.test(described) || SECRET_TEXT.test(text) || isCardNumber(text)) {
      return "credentials";
    }
  }
  if (input.sensitivity !== undefined) return input.sensitivity;
  if (PURCHASE.test(described)) return "purchase";
  if (DELETE.test(described)) return "delete";
  if (MESSAGE.test(described)) return "message";
  return null;
}
