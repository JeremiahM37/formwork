/**
 * Account creation.
 *
 * Many applicant tracking systems require registering before you can apply, so
 * formwork fills signup and login forms from stored credentials. The security
 * property under test: a password is answered only from those credentials, is
 * never taken from the model, and is never summarised into a prompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, schemaOf } from "../helpers/load.mjs";

const { validate } = lib("validate");
const { buildMessages } = lib("prompt");

const CREDS = { email: "apply@example.com", password: "correct-horse-battery", username: "danar" };

const signup = schemaOf(
  { id: "f0", label: "Email", type: "text", required: true },
  { id: "f1", label: "Password", type: "password", required: true },
  { id: "f2", label: "Confirm Password", type: "password", required: true },
  { id: "f3", label: "First Name", type: "text", required: true }
);

test("fills a signup form from stored credentials", () => {
  const { fills } = validate({}, signup, profile(), {}, CREDS);
  assert.equal(fills.f0, "apply@example.com", "the account email, not the résumé's");
  assert.equal(fills.f1, "correct-horse-battery");
  assert.equal(fills.f2, "correct-horse-battery", "confirmation must match");
  assert.equal(fills.f3, "Dana", "ordinary profile fields still fill");
});

test("a password proposed by the model is discarded and reported", () => {
  const { fills, dropped } = validate(
    { f1: "hunter2", f2: "hunter2" },
    signup,
    profile(),
    {},
    CREDS
  );
  assert.equal(fills.f1, "correct-horse-battery");
  assert.ok(
    dropped.some((d) => /never supply a password/.test(d.reason)),
    "silently overwriting would hide that the model tried"
  );
});

test("a password field is left empty when no credential is stored", () => {
  const { fills, review } = validate({ f1: "hunter2" }, signup, profile(), {}, {});
  assert.equal(fills.f1, undefined, "better an empty field than a guessed password");
  assert.ok(review.some((r) => /set your password/.test(r.reason)), "and the user is told why");
});

test("any password control is recognised regardless of its label", () => {
  // Labels vary wildly ("Create a password", "Choose password", or nothing at
  // all); the control type is the reliable signal.
  const odd = schemaOf({ id: "f0", label: "Secret phrase", type: "password", required: true });
  const { fills } = validate({}, odd, profile(), {}, CREDS);
  assert.equal(fills.f0, "correct-horse-battery");
});

test("a username field falls back to the account email", () => {
  const withUser = schemaOf({ id: "f0", label: "Username", type: "text", required: true });
  assert.equal(validate({}, withUser, profile(), {}, CREDS).fills.f0, "danar");
  const noUser = { email: "apply@example.com", password: "x" };
  assert.equal(validate({}, withUser, profile(), {}, noUser).fills.f0, "apply@example.com");
});

test("credentials never appear in a model request", () => {
  // buildMessages is given the profile only — credentials are a separate
  // argument to validate precisely so they cannot be summarised into a prompt.
  const withCreds = { ...profile(), credentials: CREDS };
  const body = buildMessages(signup, withCreds)
    .messages.map((m) => m.content)
    .join("\n");
  for (const secret of [CREDS.password, CREDS.email, CREDS.username]) {
    assert.equal(body.includes(secret), false, `${secret} reached the prompt`);
  }
});

test("a résumé-derived email does not override the account email on a signup form", () => {
  // The profile's email is pinned to "Email" fields too; on a signup form the
  // account credential has to win, or you register with the wrong address.
  const { fills } = validate({}, signup, profile(), {}, CREDS);
  assert.notEqual(fills.f0, profile().identity.email);
});

test("with no credentials configured the form still fills everything else", () => {
  const { fills } = validate({}, signup, profile(), {}, {});
  assert.equal(fills.f3, "Dana");
  assert.equal(fills.f0, profile().identity.email, "email falls back to the profile");
});
