/** Robust JSON extraction for model output (models sometimes wrap JSON in prose or fences). */
export function parseJsonLoose<T>(input: string): T | null {
  if (!input) return null;
  const cleaned = input
    .replace(/^\uFEFF/, '')
    .replace(/```json/gi, '```')
    .trim();

  const candidates: string[] = [];
  const fenced = /```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(cleaned))) candidates.push(match[1].trim());
  candidates.push(cleaned.trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      const firstBrace = candidate.search(/[[{]/);
      if (firstBrace === -1) continue;
      const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
      if (lastBrace <= firstBrace) continue;
      const slice = candidate.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice) as T;
      } catch {
        // attempt light repairs for trailing commas
        try {
          return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as T;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

/** Normalises a free-text answer for comparison (used by local grading). */
export function normaliseAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s+\-./=^²]/g, '')
    .trim();
}

export function isNumericAnswer(value: string): boolean {
  return /-?\d+(\.\d+)?/.test(value);
}
