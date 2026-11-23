// The Cedar teacher list lives only in Supabase (public.counter_teacher_directory), read by the
// server with the secret key. It must never be bundled into the website or kept in this public repo.

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "miss", "sir", "madam", "prof", "professor"]);

export function normalizeTeacherName(value) {
  const tokens = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (tokens.length && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

export function teacherEmailFromName(value) {
  const tokens = normalizeTeacherName(value).split(" ").filter(Boolean);
  if (tokens.length < 2) return null;
  return `${tokens[0]}.${tokens[tokens.length - 1]}@cedar.edu.pk`;
}
