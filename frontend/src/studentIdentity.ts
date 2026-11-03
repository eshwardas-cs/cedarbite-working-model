const STUDENT_EMAIL = /^(\d{7})@cedar\.edu\.pk$/i;

export function studentIdFromEmail(email: string): string | null {
  return STUDENT_EMAIL.exec(email.trim())?.[1] ?? null;
}

export function isCedarStudentEmail(email: string): boolean {
  return studentIdFromEmail(email) !== null;
}
