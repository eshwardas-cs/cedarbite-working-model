import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studentProfileFromId, teacherIdentityFromName } from "../shared/customer-auth.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("counter customer identity lookup", () => {
  let fetchMock;

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://cedarbite-test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "server-only-test-key");
    fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves a student ID to its Cedar email and Supabase user ID", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "student-auth-id", email: "2526245@cedar.edu.pk", full_name: "Student Name", role: "student" }]));

    await expect(studentProfileFromId("2526245", { allowMissingName: true })).resolves.toMatchObject({
      student_id: "2526245",
      full_name: "Student Name",
      email: "2526245@cedar.edu.pk",
      user_id: "student-auth-id",
    });
  });

  it("keeps an unregistered student order matchable by email after first sign-in", async () => {
    await expect(studentProfileFromId("2526245", { allowMissingName: true })).resolves.toMatchObject({
      student_id: "2526245",
      email: "2526245@cedar.edu.pk",
      user_id: null,
      profile_exists: false,
    });
  });

  it("uses the roster teacher's first.last Cedar email before the teacher signs in", async () => {
    await expect(teacherIdentityFromName("Sir Adam Asif")).resolves.toMatchObject({
      full_name: "Adam Asif",
      email: "adam.asif@cedar.edu.pk",
      user_id: null,
      profile_exists: false,
    });
  });

  it("uses the verified Supabase teacher profile when it already exists", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "teacher-auth-id", email: "adam.asif@cedar.edu.pk", full_name: "Adam Asif", role: "teacher" }]));

    await expect(teacherIdentityFromName("Adam Asif")).resolves.toMatchObject({
      full_name: "Adam Asif",
      email: "adam.asif@cedar.edu.pk",
      user_id: "teacher-auth-id",
      profile_exists: true,
    });
  });

  it("rejects a Cedar email profile whose Supabase role or name differs", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "other-auth-id", email: "adam.asif@cedar.edu.pk", full_name: "Another Person", role: "teacher" }]));

    await expect(teacherIdentityFromName("Adam Asif")).rejects.toThrow("does not match the Cedar account");
  });

  it("does not create a teacher identity for names outside the supplied roster", async () => {
    await expect(teacherIdentityFromName("Unknown Person")).rejects.toThrow("Choose a teacher from the Cedar staff list");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
