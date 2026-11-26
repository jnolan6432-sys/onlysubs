export type RosterPlayer = { name: string; email: string };

export type RosterPasteResult = {
  players: RosterPlayer[];
  unparsedLines: string[];
};

const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function clean(value: string) {
  return value
    .replace(/[\u201c\u201d\u2018\u2019]/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .replace(/^,|,$/g, "")
    .trim();
}

function extractEmail(line: string) {
  const match = line.match(emailPattern);
  return match ? clean(match[0]).toLowerCase() : null;
}

function extractName(line: string, email: string) {
  const angled = line.match(new RegExp(`^(.+?)\\s*<\\s*${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`, "i"));
  if (angled) return clean(angled[1]);

  const paren = line.match(new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\((.+?)\\)`, "i"));
  if (paren) return clean(paren[1]);

  const remainder = clean(
    line
      .replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
      .replace(/[<>(),;\t]/g, " ")
      .replace(/\s+/g, " "),
  );
  if (remainder && !remainder.includes("@")) return clean(remainder);
  return "";
}

export function parseRosterPaste(input: string): RosterPasteResult {
  const players: RosterPlayer[] = [];
  const unparsedLines: string[] = [];
  const seen = new Set<string>();
  let nameColumnIndex = -1;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = clean(rawLine);
    if (!line) continue;

    const lower = line.toLowerCase();
    if (/^(name\s*[,;\t]?\s*e?mail|e?mail\s*[,;\t]?\s*name|full name\s*[,;\t]?\s*email|first name.*last name.*email)$/i.test(lower)) continue;
    const headerTokens = line.split(/[\t,;]/).map((token) => clean(token).toLowerCase());
    if (headerTokens.length > 1 && headerTokens.every((token) => /^(name|full name|first name|last name|e?-?mail|email address|phone|gender|sex|mobile|contact)$/.test(token))) {
      nameColumnIndex = headerTokens.findIndex((token) => /^(name|full name|full_name)$/.test(token));
      continue;
    }

    const tokens = line.includes("\t")
      ? line.split("\t")
      : line.includes(";")
        ? line.split(";")
        : line.includes(",")
          ? line.split(",")
          : [line];

    let email: string | null = null;
    let name = "";

    for (const token of tokens) {
      const candidate = extractEmail(clean(token));
      if (candidate) {
        email = candidate;
        break;
      }
    }

    if (!email) {
      unparsedLines.push(rawLine.trim());
      continue;
    }

    const delimited = tokens.length > 1;
    if (delimited) {
      if (nameColumnIndex >= 0 && tokens[nameColumnIndex]) {
        const nameCandidate = clean(tokens[nameColumnIndex]);
        const nameCandidateEmail = extractEmail(nameCandidate);
        name = nameCandidateEmail
          ? extractName(nameCandidate, nameCandidateEmail)
          : nameCandidate;
      } else {
        for (const token of tokens) {
          const candidate = clean(token);
          const candidateEmail = extractEmail(candidate);
          if (candidateEmail) {
            const angledName = extractName(candidate, candidateEmail);
            if (angledName) name = angledName;
          }
        }
        if (!name) {
          name = tokens
            .map((token) => clean(token))
            .find((token) => /^[A-Za-z][A-Za-z .'-]*$/.test(token) && !extractEmail(token)) ?? "";
        }
      }
    } else {
      name = extractName(line, email);
    }

    if (!seen.has(email)) {
      seen.add(email);
      players.push({ name: clean(name), email });
    }
  }

  return { players, unparsedLines: [...new Set(unparsedLines)] };
}
