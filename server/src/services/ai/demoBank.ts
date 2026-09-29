/**
 * Offline sample content used when a student has not connected any provider key yet.
 *
 * This exists so the product is explorable end-to-end (learn → practice → test → analyse)
 * without a key. It is clearly labelled in the UI as sample content, never presented as a
 * real model answer, and is only used when no key is configured (or the student enables it).
 */
import type { PracticeQuestion, QuestionType } from '../../types/domain.js';
import { detectStudentLanguage, sampleVoice, type StudentLanguage } from './language.js';

interface BankItem extends Omit<PracticeQuestion, 'id'> {
  subject: string;
  chapter: string;
}

const BANK: BankItem[] = [
  {
    subject: 'Physics',
    chapter: 'Motion',
    topic: 'Speed and velocity',
    type: 'mcq',
    prompt: 'A car covers 150 m in 10 s. What is its average speed?',
    options: ['10 m/s', '15 m/s', '20 m/s', '25 m/s'],
    answer: '15 m/s',
    explanation: 'Average speed = total distance ÷ total time = 150 m ÷ 10 s = 15 m/s.',
    steps: ['Write what is given: distance = 150 m, time = 10 s.', 'Use the formula: speed = distance ÷ time.', 'Substitute: 150 ÷ 10 = 15.', 'Add the unit: 15 m/s.'],
    marks: 1,
    hint: 'Speed is distance divided by time.',
  },
  {
    subject: 'Physics',
    chapter: 'Motion',
    topic: 'Distance vs displacement',
    type: 'conceptual',
    prompt: 'A student walks 4 m east and then 4 m west. Explain why the distance travelled is 8 m but the displacement is 0 m.',
    answer: 'Distance counts the whole path; displacement only compares start and end points.',
    explanation:
      'Distance is the total length of the path actually covered, so 4 m + 4 m = 8 m. Displacement is the straight-line change in position from start to finish. Since the student returns to the starting point, the change in position is zero.',
    marks: 2,
  },
  {
    subject: 'Physics',
    chapter: 'Motion',
    topic: 'Graph interpretation',
    type: 'numerical',
    prompt:
      'A velocity–time graph of a cyclist is a straight line rising from 0 m/s at t = 0 s to 12 m/s at t = 6 s. Find the acceleration and the distance covered.',
    answer: 'Acceleration = 2 m/s², distance = 36 m',
    explanation:
      'The slope of a velocity–time graph gives acceleration, and the area under it gives distance. Slope = (12 − 0) ÷ (6 − 0) = 2 m/s². The area is a triangle: ½ × base × height = ½ × 6 × 12 = 36 m.',
    steps: ['Note the graph is a straight line, so acceleration is constant.', 'Acceleration = change in velocity ÷ change in time = 12 ÷ 6 = 2 m/s².', 'Distance = area under the graph = ½ × base × height.', 'Area = ½ × 6 s × 12 m/s = 36 m.'],
    marks: 3,
    hint: 'Slope gives acceleration, area gives distance.',
  },
  {
    subject: 'Physics',
    chapter: 'Units and Measurements',
    topic: 'Unit conversion',
    type: 'numerical',
    prompt: 'Convert 72 km/h into m/s and state how many metres the object covers in 5 seconds.',
    answer: '20 m/s and 100 m',
    explanation:
      'To convert km/h into m/s multiply by 5/18. 72 × 5/18 = 20 m/s. In 5 s the object covers 20 × 5 = 100 m.',
    steps: ['Use the conversion factor 1 km/h = 5/18 m/s.', '72 km/h = 72 × 5/18 = 20 m/s.', 'Distance = speed × time = 20 × 5.', 'Distance = 100 m.'],
    marks: 2,
  },
  {
    subject: 'Physics',
    chapter: "Newton's Laws",
    topic: 'Force and acceleration',
    type: 'mcq',
    prompt: 'A force of 24 N acts on a 6 kg body. What is the acceleration produced?',
    options: ['0.25 m/s²', '4 m/s²', '18 m/s²', '144 m/s²'],
    answer: '4 m/s²',
    explanation: "Newton's second law gives F = m × a, so a = F ÷ m = 24 ÷ 6 = 4 m/s².",
    marks: 1,
  },
  {
    subject: 'Physics',
    chapter: 'Gravitation',
    topic: 'Weight and mass',
    type: 'short',
    prompt: 'Why does a body weigh less on the Moon than on Earth, even though its mass is the same?',
    answer: 'Because the Moon’s gravitational acceleration (≈1.6 m/s²) is much smaller than Earth’s (≈9.8 m/s²).',
    explanation:
      'Mass is the amount of matter and does not change with location. Weight is the force of gravity, W = m × g. Since g on the Moon is about one-sixth of Earth’s g, the weight becomes about one-sixth.',
    marks: 2,
  },
  {
    subject: 'Mathematics',
    chapter: 'Linear Equations',
    topic: 'Solving equations',
    type: 'numerical',
    prompt: 'Solve for x: 3(x − 2) = 2x + 5',
    answer: 'x = 11',
    explanation: 'Expand the bracket, collect like terms and isolate x. 3x − 6 = 2x + 5 → 3x − 2x = 5 + 6 → x = 11.',
    steps: ['Expand: 3x − 6 = 2x + 5.', 'Bring x terms to one side: 3x − 2x = 5 + 6.', 'Simplify: x = 11.', 'Check: 3(11 − 2) = 27 and 2(11) + 5 = 27 ✓'],
    marks: 2,
  },
  {
    subject: 'Mathematics',
    chapter: 'Quadratic Equations',
    topic: 'Roots of equations',
    type: 'mcq',
    prompt: 'What are the roots of x² − 5x + 6 = 0?',
    options: ['1 and 6', '2 and 3', '−2 and −3', '−1 and 6'],
    answer: '2 and 3',
    explanation: 'Factorise: x² − 5x + 6 = (x − 2)(x − 3). Setting each factor to zero gives x = 2 or x = 3.',
    marks: 1,
  },
  {
    subject: 'Mathematics',
    chapter: 'Trigonometry',
    topic: 'Trigonometric ratios',
    type: 'short',
    prompt: 'In a right triangle, the side opposite to angle θ is 3 cm and the hypotenuse is 5 cm. Find sin θ, cos θ and tan θ.',
    answer: 'sin θ = 0.6, cos θ = 0.8, tan θ = 0.75',
    explanation:
      'The three ratios link the opposite side, adjacent side and hypotenuse. sin θ = 3/5 = 0.6. The adjacent side is √(5² − 3²) = 4 cm, so cos θ = 4/5 = 0.8 and tan θ = 3/4 = 0.75.',
    steps: ['Use Pythagoras to find the missing side: √(25 − 9) = 4 cm.', 'sin θ = opposite ÷ hypotenuse = 3/5.', 'cos θ = adjacent ÷ hypotenuse = 4/5.', 'tan θ = opposite ÷ adjacent = 3/4.'],
    marks: 3,
  },
  {
    subject: 'Chemistry',
    chapter: 'Chemical Reactions',
    topic: 'Balancing equations',
    type: 'mcq',
    prompt: 'Balance the equation: H₂ + O₂ → H₂O. Which set of coefficients works?',
    options: ['1, 1, 1', '2, 1, 2', '2, 2, 2', '1, 2, 1'],
    answer: '2, 1, 2',
    explanation: 'The coefficients 2, 1, 2 balance the equation: 2H₂ + O₂ → 2H₂O gives 4 hydrogen atoms and 2 oxygen atoms on each side, so every element is conserved.',
    marks: 1,
  },
  {
    subject: 'Chemistry',
    chapter: 'Acids, Bases and Salts',
    topic: 'pH scale',
    type: 'conceptual',
    prompt: 'Lemon juice has pH 2 and soap solution has pH 10. Which is acidic and what happens to litmus paper in each case?',
    answer: 'Lemon juice is acidic (blue litmus turns red); soap solution is basic (red litmus turns blue).',
    explanation:
      'pH below 7 is acidic and above 7 is basic. Lemon juice (pH 2) is acidic and turns blue litmus red. Soap solution (pH 10) is basic and turns red litmus blue.',
    marks: 2,
  },
  {
    subject: 'Biology',
    chapter: 'Cell Structure',
    topic: 'Plant vs animal cells',
    type: 'short',
    prompt: 'Give two differences between plant cells and animal cells.',
    answer: 'Plant cells have a cell wall and chloroplasts; animal cells do not (they have centrioles instead).',
    explanation:
      'Plant cells are surrounded by a rigid cellulose cell wall and contain chloroplasts for photosynthesis. Animal cells lack both, and instead have centrioles and small vacuoles.',
    marks: 2,
  },
  {
    subject: 'Biology',
    chapter: 'Photosynthesis',
    topic: 'Process of photosynthesis',
    type: 'conceptual',
    prompt: 'Write the overall equation of photosynthesis and state where it occurs in the cell.',
    answer: '6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂, in chloroplasts.',
    explanation:
      'Plants use light energy to convert carbon dioxide and water into glucose and oxygen. The reaction happens in the chloroplasts, which contain the green pigment chlorophyll.',
    marks: 2,
  },
  {
    subject: 'Computer Science',
    chapter: 'Programming Basics',
    topic: 'Loops and logic',
    type: 'mcq',
    prompt: 'What does this print?  let s = 0; for (let i = 1; i <= 4; i++) { s += i; } console.log(s);',
    options: ['4', '6', '10', '24'],
    answer: '10',
    explanation: 'The loop adds 1 + 2 + 3 + 4, which equals 10. This is a sum accumulator pattern.',
    marks: 1,
  },
  {
    subject: 'Computer Science',
    chapter: 'Programming Basics',
    topic: 'Variables',
    type: 'short',
    prompt: 'Explain the difference between a variable declared with let and one declared with const in JavaScript.',
    answer: 'let can be reassigned; const cannot be reassigned (though objects it points to can still be mutated).',
    explanation:
      'Both are block-scoped. let creates a binding you can point at a new value later. const creates a binding that must keep pointing to the same value, which prevents accidental reassignment.',
    marks: 2,
  },
];

let counter = 0;
function withId(item: BankItem): PracticeQuestion {
  counter += 1;
  return { ...item, id: `demo-${Date.now().toString(36)}-${counter}` };
}

export function demoQuestions(args: {
  subject?: string;
  chapter?: string;
  count: number;
  type?: QuestionType | 'mixed';
  difficulty?: string;
}): PracticeQuestion[] {
  const subjectLc = (args.subject ?? '').toLowerCase();
  const chapterLc = (args.chapter ?? '').toLowerCase();

  const score = (item: BankItem) => {
    let s = 0;
    if (!subjectLc || item.subject.toLowerCase().includes(subjectLc)) s += 3;
    if (chapterLc && item.chapter.toLowerCase().includes(chapterLc)) s += 4;
    if (args.type && args.type !== 'mixed' && item.type === args.type) s += 3;
    return s;
  };

  const ranked = [...BANK].sort((a, b) => score(b) - score(a));
  const chosen: BankItem[] = [];
  const seenTopics = new Set<string>();
  for (const item of ranked) {
    if (chosen.length >= args.count) break;
    if (seenTopics.has(item.topic) && chosen.length < BANK.length) continue;
    seenTopics.add(item.topic);
    chosen.push(item);
  }
  // Pad from the full bank if the filtered set was small.
  let i = 0;
  while (chosen.length < args.count && i < BANK.length) {
    const candidate = BANK[i++];
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen.slice(0, args.count).map(withId);
}

export const DEMO_BANK_SIZE = BANK.length;
export const DEMO_SUBJECTS = Array.from(new Set(BANK.map((b) => b.subject)));

/** Local grading so sample practice/exam flows work fully offline. */
export function gradeLocally(
  question: PracticeQuestion,
  rawAnswer: string,
): { isCorrect: boolean; verdict: string; explanation: string; steps?: string[] } {
  const expected = question.answer;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\\u00b2/g, '^2')
      .replace(/[^a-z0-9+\-./ =]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(rawAnswer);
  const e = norm(expected);

  let isCorrect = false;
  if (!a) isCorrect = false;
  else if (a === e || (e.length > 3 && a.includes(e)) || (a.length > 3 && e.includes(a))) isCorrect = true;
  else {
    const num = (s: string) => {
      const m = s.match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    };
    const na = num(a);
    const ne = num(e);
    if (na !== null && ne !== null && Math.abs(na - ne) < 0.01) isCorrect = true;
    else {
      const keywords = e.split(' ').filter((w) => w.length > 4);
      if (keywords.length) {
        const hits = keywords.filter((w) => a.includes(w)).length;
        isCorrect = hits / keywords.length >= 0.6;
      }
    }
  }

  return {
    isCorrect,
    verdict: isCorrect ? 'Correct' : 'Not quite',
    explanation: question.explanation,
    steps: question.steps,
  };
}

/**
 * Sample teaching answer used by the offline engine.
 *
 * The framing follows the language the student wrote in (see `language.ts`). A student who asks in
 * Hinglish and receives a formal English reply reads that as "this did not understand me" — which is
 * exactly the complaint this path used to cause. The teaching content itself stays English, because
 * that is how these students read technical material.
 */
export function demoTeachingAnswer(question: string, studentLanguage?: StudentLanguage): string {
  const voice = sampleVoice(studentLanguage ?? detectStudentLanguage(question));
  const topic = question.replace(/\s+/g, ' ').trim().slice(0, 120) || 'this topic';
  return [
    `### ${voice.heading}`,
    ``,
    `${voice.yourQuestion}: **${topic}**`,
    ``,
    `**Concept**`,
    `${voice.intro}`,
    ``,
    `_${voice.bodyNote}_`,
    ``,
    `**Explanation**`,
    `1. Identify what the question is really asking — the quantity or idea being tested.`,
    `2. List what is given and what is unknown.`,
    `3. Pick the relation that links them, then substitute carefully with units.`,
    `4. Sanity-check the answer: is the size reasonable? are the units right?`,
    ``,
    `**Example**`,
    `If a train covers 180 km in 3 hours, average speed = distance ÷ time = 180 ÷ 3 = 60 km/h, which is 60 × 5/18 ≈ 16.7 m/s.`,
    ``,
    `**Practice**`,
    `Try: a cyclist covers 45 km in 3 hours, then rests 30 minutes and covers 15 km in 30 minutes. Find the average speed for the whole journey (include the rest).`,
    ``,
    `**Quick check**`,
    `Which step of the four above do you usually skip? ${voice.connectHint} I will then explain ${topic} with real model answers, diagrams and follow-up questions.`,
  ].join('\n');
}

export function demoJsonPayload(task: string, _args: Record<string, unknown>): string {
  if (task === 'analysis') {
    return JSON.stringify({
      summary: 'Sample analysis based on this attempt set.',
      weakTopics: ['Graph interpretation', 'Unit conversion'],
      strongTopics: ['Basic motion concepts'],
      recommendedRevision: ['Practise slope/area questions on motion graphs', 'Drill the 5/18 conversion'],
    });
  }
  return JSON.stringify({ note: 'sample', questions: [] });
}

/**
 * Offline sample answer for a Code Lab question.
 *
 * Before this existed, a coding question that reached the sample engine fell through to
 * `demoTeachingAnswer`, which is written for physics problems ("substitute with units", a train-speed
 * worked example). Students saw a physics lecture in response to "why is my loop slow?" and reasonably
 * concluded the AI was broken. Code Lab now gets its own code-shaped reply: it names the language,
 * quotes the student's own code and question back, and gives mode-appropriate, genuinely useful
 * guidance — while still stating plainly that no model is connected.
 */
export function demoCodingAnswer(args: {
  mode: 'review' | 'explain' | 'bugs' | 'improve' | 'ask' | 'build';
  language: string;
  question?: string;
  code?: string;
  output?: string;
  studentLanguage?: StudentLanguage;
}): string {
  const language = (args.language || 'javascript').toLowerCase();
  const code = (args.code ?? '').trim();
  const question = (args.question ?? '').trim();
  const lineCount = code ? code.split('\n').length : 0;

  const heading: Record<typeof args.mode, string> = {
    review: 'Code review',
    explain: 'Code walkthrough',
    bugs: 'Bug hunt',
    improve: 'Improvement plan',
    ask: 'Answer',
    build: 'Build plan',
  };

  /*
   * Mirror the student's language in the framing, exactly as the model path does through
   * `MIRROR_RULE`. A Hinglish question answered with a formal English sample was the clearest
   * example of "the AI does not understand me"; the offline path now answers in the same language
   * the student used, while keeping code, headings and error text in English.
   */
  const voice = sampleVoice(args.studentLanguage ?? detectStudentLanguage(question || args.code || ''));
  const lines: string[] = [
    `### ${heading[args.mode]} — ${voice.headingSuffix}`,
    '',
    `**Language:** ${language}${lineCount ? ` · **${lineCount} line${lineCount === 1 ? '' : 's'}** of code submitted` : ''}`,
    '',
  ];

  if (question) {
    lines.push(`**${voice.yourQuestion}**`, `> ${question}`, '');
  }

  lines.push(voice.notice, `${voice.connectHint}`, '');

  // Mode-specific, genuinely useful orientation. Nothing here pretends to have read the code.
  const guides: Record<typeof args.mode, string[]> = {
    review: [
      '**What a review checks**',
      '1. Correctness — does it produce the right result for normal input, and for edge cases (empty list, zero, negative numbers)?',
      '2. Boundaries — loops that stop one step early or one step late are the most common beginner bug.',
      '3. Readability — names that say what a value means, and one idea per function.',
      '4. Complexity — how the work grows as the input grows; a loop inside a loop is usually the first place to look.',
      '',
      `**${voice.whileYouWait}**`,
      '- Run the program with the smallest input you can think of, then the largest.',
      `- Add one \`console.log\`${language === 'python' ? ' — or `print()`' : ''} inside the loop and watch how the values change.`,
    ],
    explain: [
      '**How this code reads**',
      '1. Find the entry point — the first statement that actually runs.',
      '2. Follow the data: what goes in, what each variable holds after every step.',
      '3. Mark the branch or loop that decides the final result, then trace one input through it by hand.',
      '',
      `**${voice.whileYouWait}**`,
      `- Take the smallest input the program accepts and write down each value on paper as you trace it.`,
      '- Rename one variable to what it really stores; the code usually becomes obvious.',
    ],
    bugs: [
      '**Where to look first** (in the order that catches most real bugs)',
      '1. Loop bounds — `<` versus `<=`, and whether the last element is actually visited.',
      '2. Values used before they are set, or reset inside a loop that should accumulate.',
      '3. Types — comparing a number to a string, or mixing integer and floating-point division.',
      '4. Termination — every loop and recursive call needs a reachable exit.',
      '',
      `**${voice.whileYouWait}**`,
      '- Print the loop index and the accumulator on each pass; the wrong step is almost always visible.',
      `- Test the boundary inputs: 0, 1, empty, and exactly-one-element.`,
    ],
    improve: [
      '**A practical order of improvements**',
      '1. Correctness first — any change that could alter the result comes before style.',
      '2. Structure — extract the repeated block into a named function.',
      '3. Complexity — replace a nested loop with a lookup table when you scan the same data twice.',
      '4. Clarity — rename, then comment only where the reason for a step is not obvious.',
      '',
      `**${voice.whileYouWait}**`,
      `- Ask: "if this input doubled, how much slower would it get?" That answer names the complexity.`,
    ],
    ask: [
      '**To get the most from this question**',
      '- Mention the input you used, the output you got, and the output you expected.',
      '- Paste the exact error text if one appeared — the first line usually identifies the cause.',
      '',
      '**Things worth checking yourself right now**',
      `- Does the program run at all? Use **Run** in the Output panel — errors there point at the line.`,
      '- Is the value exactly what you expect at the point you use it? Print it just before.',
    ],
    build: [
      '**A small-project plan you can follow**',
      '1. Write the smallest version that produces visible output, then grow it one feature at a time.',
      '2. Keep data in one place (an array or object) and render it from that — do not duplicate state.',
      '3. For HTML projects, press **Preview** after each change; for JavaScript, use `console.log` in Output.',
      '',
      `**${voice.whileYouWait}**`,
      '- Decide the single next visible change, make only that change, then run it again.',
    ],
  };

  lines.push(...guides[args.mode]);

  if (code) {
    lines.push(
      '',
      '**Your code, for reference**',
      '```' + (language === 'python' ? 'python' : language === 'html' ? 'html' : 'javascript'),
      code.slice(0, 1200),
      '```',
    );
  }

  lines.push(
    '',
    '---',
    voice.footer,
  );

  return lines.join('\n');
}
