import { describe, expect, it } from "vitest";
import { staffEmailFormatError, validateStaffEmail } from "./emailValidation";

describe("optional staff email syntax", () => {
  it.each(["not-an-email", "name@", "@example.com", "a@@example.com", "first last@example.com", "name@exa mple.com", "name@example..com", "name@-example.com", "name@example-.com", "a@example.com,b@example.com"])("rejects new invalid email %s", (email) => {
    expect(validateStaffEmail(email)).toEqual({ error: staffEmailFormatError, warning: "" });
  });

  it.each(["", "   ", "name@example.com", "Name+tag@sub.example.com", "o'connor@example.com", "person@intranet", " name@example.com "])("accepts optional or HTML-like address %s", (email) => {
    expect(validateStaffEmail(email)).toEqual({ error: "", warning: "" });
  });

  it("warns without rejecting an unchanged historical invalid address", () => {
    expect(validateStaffEmail("not-an-email", "not-an-email")).toMatchObject({ error: "", warning: expect.stringContaining("Ранее сохранённый email") });
  });

  it("rejects changing a legacy address to a different invalid value", () => {
    expect(validateStaffEmail("another-bad-address", "not-an-email")).toEqual({ error: staffEmailFormatError, warning: "" });
  });

  it("allows clearing or correcting a legacy address", () => {
    expect(validateStaffEmail("", "not-an-email")).toEqual({ error: "", warning: "" });
    expect(validateStaffEmail("name@example.com", "not-an-email")).toEqual({ error: "", warning: "" });
  });
});
