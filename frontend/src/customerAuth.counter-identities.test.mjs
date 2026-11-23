import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studentProfileFromId, teacherIdentityFromName } from "../shared/customer-auth.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("counter customer identity lookup", () => {
  let fetchMock;
  const teacherRoster = [
    { full_name: "Test Teacher", cedar_email: "test.teacher@cedar.edu.pk" },
    { full_name: "Sample Lecturer", cedar_email: "sample.lecturer@cedar.edu.pk" },
  ];

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

  it("resolves a unique first name from the Supabase directory before the teacher signs in", async () => {
    fetchMock
      .mockResolvedValueOnce(json(teacherRoster))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([{ cedar_email: "test.teacher@cedar.edu.pk", full_name: "Test Teacher" }]));

    await expect(teacherIdentityFromName("Test")).resolves.toMatchObject({
      full_name: "Test Teacher",
      email: "test.teacher@cedar.edu.pk",
      user_id: null,
      profile_exists: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain("/rest/v1/counter_teacher_names?on_conflict=cedar_email");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      cedar_email: "test.teacher@cedar.edu.pk",
      full_name: "Test Teacher",
      recorded_by: "counter",
    });
    expect(fetchMock.mock.calls[2][1].method).toBe("POST");
  });

  it("uses the verified Supabase teacher profile when it already exists", async () => {
    fetchMock.mockResolvedValueOnce(json(teacherRoster)).mockResolvedValueOnce(json([{ id: "teacher-auth-id", email: "test.teacher@cedar.edu.pk", full_name: "Test Teacher", role: "teacher" }]));

    await expect(teacherIdentityFromName("Sir Test Teacher")).resolves.toMatchObject({
      full_name: "Test Teacher",
      email: "test.teacher@cedar.edu.pk",
      user_id: "teacher-auth-id",
      profile_exists: true,
    });
  });

  it("rejects a Cedar email profile whose Supabase role or name differs", async () => {
    fetchMock.mockResolvedValueOnce(json(teacherRoster)).mockResolvedValueOnce(json([{ id: "other-auth-id", email: "test.teacher@cedar.edu.pk", full_name: "Another Person", role: "teacher" }]));

    await expect(teacherIdentityFromName("Test Teacher")).rejects.toThrow("does not match the Cedar account");
  });

  it("rejects a partial name when it matches more than one Cedar teacher", async () => {
    fetchMock.mockResolvedValueOnce(json([
      ...teacherRoster,
      { full_name: "Test Khan", cedar_email: "test.khan@cedar.edu.pk" },
    ]));

    await expect(teacherIdentityFromName("Test")).rejects.toThrow("More than one Cedar teacher matches");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects names with no match in the Supabase directory", async () => {
    fetchMock.mockResolvedValueOnce(json(teacherRoster));

    await expect(teacherIdentityFromName("Unknown Person")).rejects.toThrow("No Cedar teacher matched that name");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
