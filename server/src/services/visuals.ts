/**
 * Visual learning helper (spec §22).
 *
 * We never inject images into every answer. Instead the model may request a visual (see
 * prompts.tutorSystem) and, when it does not, a small keyword heuristic catches the handful of
 * topics where a diagram genuinely helps. Suggestions are text + a search phrase: no third-party
 * image is fetched or embedded server-side, so nothing slow or unreliable lands in the answer.
 */
import type { VisualSuggestion } from '../types/domain.js';

interface Rule {
  test: RegExp;
  make: (m: RegExpMatchArray) => VisualSuggestion;
}

const RULES: Rule[] = [
  {
    test: /\b(velocity[- ]time|distance[- ]time|v[- ]t graph|displacement[- ]time|graph (?:of|between))\b/i,
    make: () => ({
      title: 'Motion graph anatomy',
      kind: 'chart',
      description: 'Axes, slope = acceleration, area under the curve = distance travelled.',
      query: 'velocity time graph slope area acceleration diagram',
    }),
  },
  {
    test: /\b(mitosis|meiosis|cell division|plant cell|animal cell|chloroplast|mitochondri)\w*/i,
    make: (m) => ({
      title: m[0].toLowerCase().includes('cell') ? 'Cell structure' : 'Stages of cell division',
      kind: 'diagram',
      description: 'Labelled parts so you can name each one in the exam.',
      query: `${m[0].toLowerCase()} labelled diagram school`,
    }),
  },
  {
    test: /\b(digestive system|respiratory system|human heart|nephron|neuron|eye|ear)\b/i,
    make: (m) => ({
      title: 'Human body system',
      kind: 'diagram',
      description: 'Labelled diagram showing the order things happen in.',
      query: `${m[0].toLowerCase()} labelled diagram`,
    }),
  },
  {
    test: /\b(ray diagram|convex lens|concave mirror|lens|mirror|refraction|reflection|prism)\b/i,
    make: (m) => ({
      title: 'Ray diagram',
      kind: 'diagram',
      description: 'How the rays travel, and where the image forms.',
      query: `${m[0].toLowerCase()} ray diagram rules`,
    }),
  },
  {
    test: /\b(circuit|resistor|ammeter|voltmeter|ohm'?s law|series and parallel)\b/i,
    make: () => ({
      title: 'Circuit symbols and layout',
      kind: 'diagram',
      description: 'Correct symbols plus how series and parallel differ.',
      query: 'electric circuit symbols series parallel diagram class 10',
    }),
  },
  {
    test: /\b(map|latitude|longitude|monsoon|plateau|delta|river system)\b/i,
    make: (m) => ({
      title: 'Locate it on a map',
      kind: 'map',
      description: 'Seeing the location makes the geography question click.',
      query: `${m[0].toLowerCase()} india map labelled`,
    }),
  },
  {
    test: /\b(French Revolution|Mughal|Harappa|Indus Valley|freedom struggle|freedom movement|Revolt of 1857)\b/i,
    make: (m) => ({
      title: 'Historical visual',
      kind: 'photo',
      description: 'A period image or timeline helps you anchor the dates.',
      query: `${m[0]} timeline historical photograph`,
    }),
  },
  {
    test: /\b(periodic table|solar system|photosynthesis|water cycle|nitrogen cycle|digestive)\b/i,
    make: (m) => ({
      title: 'Concept visual',
      kind: 'illustration',
      description: 'One picture that shows the whole process at a glance.',
      query: `${m[0].toLowerCase()} labelled illustration`,
    }),
  },
  {
    test: /\b(pythagoras|triangle|circle theorem|geometry)\b/i,
    make: (m) => ({
      title: 'Geometry construction',
      kind: 'diagram',
      description: 'The construction steps drawn out.',
      query: `${m[0].toLowerCase()} construction diagram steps`,
    }),
  },
];

export function visualSuggestionsFor(text: string, limit = 1): VisualSuggestion[] {
  const out: VisualSuggestion[] = [];
  for (const rule of RULES) {
    if (out.length >= limit) break;
    const match = rule.test.exec(text);
    if (match) {
      const suggestion = rule.make(match);
      if (!out.some((s) => s.title === suggestion.title)) out.push(suggestion);
    }
  }
  return out;
}
