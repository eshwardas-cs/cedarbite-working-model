import { describe, expect, it } from "vitest";
import { isCedarStudentEmail, studentIdFromEmail } from "./studentIdentity";

describe("Cedar student email identity", () => {
  it("extracts the seven digit student ID", () => {
    expect(studentIdFromEmail(" 2526245@cedar.edu.pk ")).toBe("2526245");
    expect(studentIdFromEmail("2526245@CEDAR.EDU.PK")).toBe("2526245");
  });

  it("rejects non-Cedar addresses and IDs with the wrong length", () => {
    for (const email of ["student@gmail.com", "252624@cedar.edu.pk", "25262458@cedar.edu.pk", "ali@cedar.edu.pk"]) {
      expect(isCedarStudentEmail(email)).toBe(false);
      expect(studentIdFromEmail(email)).toBeNull();
    }
  });
});
