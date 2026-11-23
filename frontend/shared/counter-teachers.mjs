export const COUNTER_TEACHER_NAMES = [
  "Abdul Ghani Noor",
  "Abdullah Saleem Ghelli",
  "Abdullah Shahmeer",
  "Adam Asif",
  "Adeel Paperwala",
  "Adil Usman",
  "Ahmad Karim",
  "Ammar Abid",
  "Anushay Anis",
  "Arsalan Farrukh",
  "Asad Kothari",
  "Asma Raza",
  "Aysha Sheikh",
  "Bilal Kurd",
  "Dilnaz X Avari",
  "Dr Mustafa Arif",
  "Fareeha Ghafoor",
  "Farhan Khan",
  "Hamza Shafiq",
  "Hiba Saigal",
  "Iftikhar Zaidi",
  "Jarrar Hashmi",
  "Junaina Junaid",
  "Kamran Abdul Salam",
  "Khalida Uzma",
  "Mariam Reza",
  "Moinuddin Ali",
  "Muhammad Ali Khan",
  "Muhammad Anas",
  "Muhammad Haris",
  "Muzammil Abbas",
  "Nida Malik",
  "Omair Masood",
  "Parsa Asif",
  "Roque Martin D'Mello",
  "Salma Baig",
  "Salman Amin",
  "Saman Bashir",
  "Shahzad Naeem",
  "Shahzaib Latafat",
  "Sheheryar Rashid",
  "Tayyaba Sami Khan",
  "Yawer Hussain",
  "Zain Merchant",
  "Zarmina Raza",
  "Zeeshan Warsi",
  "Zehra Ali",
  "Zufashan Hasan",
];

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
