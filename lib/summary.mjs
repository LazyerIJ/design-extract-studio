function firstMatch(markdown, pattern, fallback = null) {
  const match = markdown.match(pattern);
  return match?.[1]?.trim() || fallback;
}

function numberMatch(markdown, pattern) {
  const value = firstMatch(markdown, pattern);
  return value === null ? null : Number.parseInt(value, 10);
}

export function parseDesignSummary(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return null;

  const scoreMatch = markdown.match(
    /\*\*Overall:\s*(\d+)\/100\s*\(Grade:\s*([A-F][+-]?)\)\*\*/i,
  );
  const wcagMatch = markdown.match(
    /\*\*Overall Score:\s*(\d+)%\*\*\s*[—-]\s*(\d+)\s+passing,\s*(\d+)\s+failing/i,
  );
  const primarySection = markdown.match(
    /### Primary Colors\s+[\s\S]*?\n\|[-|\s]+\|\n([\s\S]*?)(?:\n\n|###)/,
  );
  const colors = [];
  if (primarySection) {
    for (const row of primarySection[1].split("\n")) {
      const match = row.match(/\|\s*([^|]+?)\s*\|\s*`(#[0-9a-f]{6})`/i);
      if (match) colors.push({ role: match[1].trim(), value: match[2] });
    }
  }

  const fonts = [];
  const typographySection = markdown.match(
    /### Font Families\s+([\s\S]*?)(?:\n###|\n##)/,
  );
  if (typographySection) {
    for (const match of typographySection[1].matchAll(/-\s+\*\*([^*]+)\*\*/g)) {
      fonts.push(match[1].trim());
    }
  }

  return {
    title: firstMatch(markdown, /^# Design Language:\s*(.+)$/m),
    sourceUrl: firstMatch(markdown, /> Extracted from `([^`]+)`/),
    extractedAt: firstMatch(markdown, /> Extracted from `[^`]+` on (.+)$/m),
    elementsAnalyzed: numberMatch(markdown, />\s*(\d+)\s+elements analyzed/),
    designScore: scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null,
    grade: scoreMatch?.[2] ?? null,
    wcagScore: wcagMatch ? Number.parseInt(wcagMatch[1], 10) : null,
    wcagPassing: wcagMatch ? Number.parseInt(wcagMatch[2], 10) : null,
    wcagFailing: wcagMatch ? Number.parseInt(wcagMatch[3], 10) : null,
    spacingBase: numberMatch(markdown, /\*\*Base unit:\*\*\s*(\d+)px/),
    colors,
    fonts,
    componentPatterns: [
      ...markdown.matchAll(/^###\s+(.+?)\s+\((\d+)\s+instances\)$/gm),
    ].map((match) => ({
      name: match[1].trim(),
      count: Number.parseInt(match[2], 10),
    })),
  };
}
