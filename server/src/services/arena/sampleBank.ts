/**
 * Deterministic sample question generator for Arena papers.
 *
 * Used in two honest situations:
 *   1. demo/seed data — so a full-size paper can exist without any AI key (flagged source = 'demo');
 *   2. last-resort filler — when the AI is unavailable *and* the curated offline bank runs short.
 *
 * Every question is generated from a parameterised template, so numbers vary, exactly one option is
 * correct, and the explanation states the answer (which is what the validation pipeline checks).
 * These are practice-grade questions, not a substitute for a real paper — every one is labelled.
 */
import type { ArenaDifficulty, ArenaGeneratedQuestion, ArenaQuestionType } from '../../types/arena.js';

export interface SampleQuery {
  subject: string;
  /** Difficulty the section is asking for — also used to rank the pool. */
  difficulty: ArenaDifficulty;
  /**
   * When true the question keeps the template's own difficulty instead of the requested one. Used
   * when a section has to be widened to the whole subject pool: the paper then still says the truth
   * about each question rather than relabelling an easy item as hard.
   */
  keepTemplateDifficulty?: boolean;
  type: ArenaQuestionType;
  count: number;
  chapters?: string[];
  /** Same seed → same paper (used by the demo seeder for reproducible results). */
  seed?: number;
}

type Rng = () => number;

function createRng(seed: number): Rng {
  let state = (seed || 1) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const int = (rng: Rng, min: number, max: number) => Math.floor(min + rng() * (max - min + 1));
const pick = <T>(rng: Rng, list: T[]): T => list[Math.floor(rng() * list.length)] as T;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

interface Draft {
  prompt: string;
  options?: string[];
  answer: string;
  explanation: string;
  topic: string;
  chapter: string;
}

interface Template {
  subject: string;
  chapter: string;
  difficulty: ArenaDifficulty;
  type: ArenaQuestionType;
  make: (rng: Rng) => Draft;
}

/** Builds four options from the correct value plus three distractors, then shuffles them. */
function mcq(rng: Rng, correct: string, distractors: string[], unit = ''): { options: string[]; answer: string } {
  const pool = [correct, ...distractors.filter((d) => d !== correct)];
  const unique = [...new Set(pool)].slice(0, 4);
  while (unique.length < 4) unique.push(`None of these (${unique.length})`);
  const shuffled = [...unique].sort(() => rng() - 0.5);
  return { options: shuffled.map((value) => `${value}${unit}`), answer: `${correct}${unit}` };
}

/**
 * Plausible distractor values around a correct value.
 * Small or very large magnitudes (10⁻¹⁰ mol/L, 6.4 × 10⁶) get multiplicative distractors instead of
 * additive ones, otherwise the options would be absurd on the page.
 */
function optionsAround(rng: Rng, value: number, digits = 2): string[] {
  const magnitude = Math.abs(value);
  const multiplicative = magnitude > 0 && (magnitude < 0.01 || magnitude >= 1000);
  const set = new Set<string>();
  const format = (input: number) => (multiplicative ? input.toExponential(1) : String(round(input, digits)));
  const correct = format(value);
  let guard = 0;
  while (set.size < 3 && guard < 60) {
    guard += 1;
    const candidate = multiplicative
      ? value * pick(rng, [0.1, 0.5, 2, 5, 10, 0.2])
      : value + (rng() * 2 - 1) * Math.max(magnitude * 0.15, 0.5);
    const formatted = format(candidate);
    if (formatted !== correct) set.add(formatted);
  }
  while (set.size < 3) set.add(format(value * (set.size + 2)));
  return [...set];
}

/* ------------------------------------------------------------------ */
/* Physics                                                             */
/* ------------------------------------------------------------------ */

const PHYSICS: Template[] = [
  {
    subject: 'Physics',
    chapter: 'Motion in a Straight Line',
    difficulty: 'easy',
    type: 'numerical',
    make: (rng) => {
      const u = int(rng, 2, 12);
      const a = int(rng, 1, 5);
      const t = int(rng, 3, 8);
      const s = u * t + 0.5 * a * t * t;
      return {
        prompt: `A body starts with an initial velocity of ${u} m/s and moves with a uniform acceleration of ${a} m/s². Find the distance it covers in ${t} seconds.`,
        answer: `${round(s)} m`,
        explanation: `Use s = u·t + ½·a·t². Substituting u = ${u} m/s, a = ${a} m/s² and t = ${t} s gives s = ${u}×${t} + ½×${a}×${t}² = ${round(s)} m.`,
        topic: 'Uniform acceleration',
        chapter: 'Motion in a Straight Line',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Laws of Motion',
    difficulty: 'easy',
    type: 'numerical',
    make: (rng) => {
      const m = int(rng, 2, 12);
      const a = int(rng, 2, 9);
      const f = m * a;
      return {
        prompt: `A force acts on a body of mass ${m} kg and produces an acceleration of ${a} m/s². Calculate the magnitude of the force.`,
        answer: `${f} N`,
        explanation: `From Newton's second law, F = m·a = ${m} kg × ${a} m/s² = ${f} N.`,
        topic: 'Newton’s second law',
        chapter: 'Laws of Motion',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Laws of Motion',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const m = int(rng, 2, 10);
      const v = int(rng, 4, 20);
      const t = int(rng, 2, 8);
      const f = (m * v) / t;
      const { options, answer } = mcq(rng, `${round(f)} N`, optionsAround(rng, f), '');
      return {
        prompt: `A body of mass ${m} kg, initially at rest, attains a velocity of ${v} m/s in ${t} seconds. What is the average force acting on it?`,
        options,
        answer,
        explanation: `Acceleration a = (v − u)/t = (${v} − 0)/${t} = ${round(v / t)} m/s². Then F = m·a = ${m} × ${round(v / t)} = ${round(f)} N, which is the correct option.`,
        topic: 'Force and momentum change',
        chapter: 'Laws of Motion',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Work, Energy and Power',
    difficulty: 'medium',
    type: 'numerical',
    make: (rng) => {
      const m = int(rng, 2, 8);
      const h = int(rng, 5, 20);
      const energy = m * 9.8 * h;
      return {
        prompt: `A block of mass ${m} kg is lifted to a height of ${h} m at a constant speed. Taking g = 9.8 m/s², find the work done against gravity.`,
        answer: `${round(energy)} J`,
        explanation: `Work done against gravity = m·g·h = ${m} × 9.8 × ${h} = ${round(energy)} J.`,
        topic: 'Gravitational potential energy',
        chapter: 'Work, Energy and Power',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Current Electricity',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const r1 = int(rng, 2, 12);
      const r2 = int(rng, 2, 12);
      const series = r1 + r2;
      const product = (r1 * r2) / (r1 + r2);
      const { options, answer } = mcq(rng, `${r1 + r2} Ω`, [`${round(product)} Ω`, `${round((r1 + r2) / 2)} Ω`, `${r1 + r2 + 1} Ω`]);
      return {
        prompt: `Two resistors of ${r1} Ω and ${r2} Ω are connected in series. What is the equivalent resistance of the combination?`,
        options,
        answer,
        explanation: `Resistances in series add directly: R = ${r1} + ${r2} = ${series} Ω, so the option ${answer} is correct. The value ${round(product)} Ω would apply only if they were in parallel.`,
        topic: 'Series and parallel resistance',
        chapter: 'Current Electricity',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Current Electricity',
    difficulty: 'hard',
    type: 'numerical',
    make: (rng) => {
      const v = int(rng, 6, 24);
      const r1 = int(rng, 2, 8);
      const r2 = int(rng, 3, 10);
      const parallel = (r1 * r2) / (r1 + r2);
      const current = v / parallel;
      return {
        prompt: `A ${v} V battery is connected across a parallel combination of ${r1} Ω and ${r2} Ω resistors. Find the total current drawn from the battery.`,
        answer: `${round(current)} A`,
        explanation: `Parallel equivalent resistance R = (${r1} × ${r2})/(${r1} + ${r2}) = ${round(parallel)} Ω. Then I = V/R = ${v}/${round(parallel)} = ${round(current)} A.`,
        topic: 'Parallel circuits',
        chapter: 'Current Electricity',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Ray Optics',
    difficulty: 'hard',
    type: 'numerical',
    make: (rng) => {
      const f = int(rng, 10, 30);
      const u = f * 2;
      // Mirror formula: 1/v + 1/u = 1/f (Cartesian sign convention with u negative)
      const v = (u * f) / (u - f);
      const m = v / u;
      return {
        prompt: `An object is placed ${u} cm in front of a concave mirror of focal length ${f} cm. Find the position of the image from the mirror.`,
        answer: `${round(v)} cm`,
        explanation: `Using the mirror formula 1/v = 1/f − 1/u with u = −${u} cm and f = −${f} cm gives v = −${round(v)} cm, so the image forms ${round(v)} cm in front of the mirror (magnification ${round(m, 2)}).`,
        topic: 'Mirror formula',
        chapter: 'Ray Optics',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Units and Measurements',
    difficulty: 'easy',
    type: 'conceptual',
    make: (rng) => {
      const speed = pick(rng, [36, 54, 72, 90, 108]);
      const mps = round(speed / 3.6, 1);
      const { options, answer } = mcq(rng, `${mps} m/s`, [`${round(speed * 3.6, 1)} m/s`, `${round(speed / 6, 1)} m/s`, `${round(speed, 1)} m/s`], '');
      return {
        prompt: `To convert a speed from km/h to m/s we multiply by 5/18. Using this, express ${speed} km/h in m/s.`,
        options,
        answer,
        explanation: `Multiply by 5/18: ${speed} × 5/18 = ${mps} m/s, which is the correct option. Multiplying by 18/5 would convert the other way round.`,
        topic: 'Unit conversion',
        chapter: 'Units and Measurements',
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Chemistry                                                           */
/* ------------------------------------------------------------------ */

const CHEMISTRY: Template[] = [
  {
    subject: 'Chemistry',
    chapter: 'Some Basic Concepts of Chemistry',
    difficulty: 'easy',
    type: 'numerical',
    make: (rng) => {
      const mass = int(rng, 4, 40);
      const molarMass = pick(rng, [40, 44, 58.5, 18, 32]);
      const moles = mass / molarMass;
      return {
        prompt: `Calculate the number of moles in ${mass} g of a substance whose molar mass is ${molarMass} g/mol.`,
        answer: `${round(moles)} mol`,
        explanation: `Moles = given mass ÷ molar mass = ${mass} ÷ ${molarMass} = ${round(moles)} mol.`,
        topic: 'Mole concept',
        chapter: 'Some Basic Concepts of Chemistry',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Structure of Atom',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const z = int(rng, 11, 20);
      const neutrons = int(rng, z - 2, z + 3);
      const massNumber = z + neutrons;
      const { options, answer } = mcq(rng, String(massNumber), [String(z), String(neutrons), String(massNumber + 1)]);
      return {
        prompt: `An atom has atomic number ${z} and contains ${neutrons} neutrons in its nucleus. What is its mass number?`,
        options,
        answer,
        explanation: `Mass number = protons + neutrons = ${z} + ${neutrons} = ${massNumber}, so the correct option is ${massNumber}. The atomic number ${z} counts protons only.`,
        topic: 'Atomic structure',
        chapter: 'Structure of Atom',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Equilibrium',
    difficulty: 'medium',
    type: 'numerical',
    make: (rng) => {
      const h = int(rng, 1, 9);
      const exponent = 14 - h;
      const oh = Math.pow(10, -exponent);
      return {
        prompt: `The pH of a solution is ${h}. Calculate the hydroxide ion concentration [OH⁻] in the solution at 25 °C.`,
        answer: `${oh.toExponential(1)} M`,
        explanation: `pH + pOH = 14, so pOH = 14 − ${h} = ${exponent}. [OH⁻] = 10^(−pOH) = 10^(−${exponent}) = ${oh.toExponential(1)} M.`,
        topic: 'pH and pOH',
        chapter: 'Equilibrium',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Chemical Reactions and Equations',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const water = pick(rng, [2, 4, 6]);
      const oxygen = water / 2;
      const { options, answer } = mcq(rng, String(water), [String(water - 1), String(water + 1), String(water * 2)]);
      return {
        prompt: `Balance the equation: __ H₂ + __ O₂ → ${water} H₂O. What coefficient of H₂ is required?`,
        options,
        answer,
        explanation: `Water has two hydrogen atoms per molecule, so ${water} H₂O molecules need ${water} H₂ molecules; the oxygen coefficient is ${oxygen}. The correct option is therefore ${water}.`,
        topic: 'Balancing equations',
        chapter: 'Chemical Reactions and Equations',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Thermodynamics',
    difficulty: 'hard',
    type: 'numerical',
    make: (rng) => {
      const mass = int(rng, 20, 200);
      const c = round(2 + rng() * 2, 2);
      const deltaT = int(rng, 5, 40);
      const q = mass * c * deltaT;
      return {
        prompt: `Calculate the heat required to raise the temperature of ${mass} g of a substance of specific heat capacity ${c} J/g°C by ${deltaT} °C.`,
        answer: `${round(q)} J`,
        explanation: `q = m·c·ΔT = ${mass} × ${c} × ${deltaT} = ${round(q)} J.`,
        topic: 'Heat capacity',
        chapter: 'Thermodynamics',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Periodic Classification',
    difficulty: 'easy',
    type: 'conceptual',
    make: (rng) => {
      const groups = [
        { element: 'Na', group: 'Alkali metals', distractor: ['Halogens', 'Noble gases', 'Alkaline earth metals'] },
        { element: 'Cl', group: 'Halogens', distractor: ['Alkali metals', 'Noble gases', 'Transition metals'] },
        { element: 'Ca', group: 'Alkaline earth metals', distractor: ['Alkali metals', 'Halogens', 'Noble gases'] },
        { element: 'Fe', group: 'Transition metals', distractor: ['Alkali metals', 'Halogens', 'Noble gases'] },
      ];
      const chosen = pick(rng, groups);
      const { options, answer } = mcq(rng, chosen.group, chosen.distractor);
      return {
        prompt: `${chosen.element} belongs to which family of elements in the periodic table?`,
        options,
        answer,
        explanation: `${chosen.element} shows the characteristic properties of the ${chosen.group}, so "${chosen.group}" is the correct option.`,
        topic: 'Periodic trends',
        chapter: 'Periodic Classification',
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Mathematics                                                         */
/* ------------------------------------------------------------------ */

const MATHEMATICS: Template[] = [
  {
    subject: 'Mathematics',
    chapter: 'Quadratic Equations',
    difficulty: 'easy',
    type: 'numerical',
    make: (rng) => {
      const r1 = int(rng, 1, 9);
      const r2 = int(rng, 1, 9);
      const sum = r1 + r2;
      const product = r1 * r2;
      return {
        prompt: `For the quadratic equation x² − ${sum}x + ${product} = 0, find the sum of its roots.`,
        answer: String(sum),
        explanation: `For ax² + bx + c = 0 the sum of roots is −b/a = ${sum}/1 = ${sum}. (The roots are ${r1} and ${r2}.)`,
        topic: 'Roots of quadratic equations',
        chapter: 'Quadratic Equations',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Trigonometry',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const triples = [
        { sin: '3/5', cos: '4/5' },
        { sin: '5/13', cos: '12/13' },
        { sin: '8/17', cos: '15/17' },
        { sin: '7/25', cos: '24/25' },
      ];
      const chosen = pick(rng, triples);
      const { options, answer } = mcq(rng, chosen.cos, ['1/2', chosen.sin, '1']);
      return {
        prompt: `If sin θ = ${chosen.sin} for an acute angle θ, what is the value of cos θ?`,
        options,
        answer,
        explanation: `Using sin²θ + cos²θ = 1, cos²θ = 1 − (${chosen.sin})², so cos θ = ${chosen.cos}, which is the correct option.`,
        topic: 'Trigonometric ratios',
        chapter: 'Trigonometry',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Sequences and Series',
    difficulty: 'medium',
    type: 'numerical',
    make: (rng) => {
      const a = int(rng, 2, 12);
      const d = int(rng, 2, 9);
      const n = int(rng, 8, 20);
      const term = a + (n - 1) * d;
      return {
        prompt: `Find the ${n}th term of the arithmetic progression whose first term is ${a} and common difference is ${d}.`,
        answer: String(term),
        explanation: `aₙ = a + (n − 1)d = ${a} + (${n} − 1) × ${d} = ${a} + ${(n - 1) * d} = ${term}.`,
        topic: 'Arithmetic progression',
        chapter: 'Sequences and Series',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Coordinate Geometry',
    difficulty: 'medium',
    type: 'numerical',
    make: (rng) => {
      const x1 = int(rng, -6, 6);
      const y1 = int(rng, -6, 6);
      const dx = int(rng, 3, 9);
      const dy = int(rng, 3, 9);
      const x2 = x1 + dx;
      const y2 = y1 + dy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return {
        prompt: `Find the distance between the points A(${x1}, ${y1}) and B(${x2}, ${y2}).`,
        answer: `${round(distance)}`,
        explanation: `Distance = √((x₂ − x₁)² + (y₂ − y₁)²) = √(${dx}² + ${dy}²) = √${dx * dx + dy * dy} = ${round(distance)}.`,
        topic: 'Distance formula',
        chapter: 'Coordinate Geometry',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Probability',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const total = pick(rng, [12, 20, 25, 30, 40]);
      const favourable = int(rng, 2, Math.max(3, Math.floor(total / 2)));
      const probability = round(favourable / total, 3);
      const { options, answer } = mcq(
        rng,
        `${probability}`,
        [`${round(1 - probability, 3)}`, `${round(favourable / (total - favourable), 3)}`, `${round(favourable / total / 2, 3)}`],
      );
      return {
        prompt: `A bag contains ${total} identical balls of which ${favourable} are red. One ball is drawn at random. What is the probability that it is red?`,
        options,
        answer,
        explanation: `Probability = favourable outcomes ÷ total outcomes = ${favourable}/${total} = ${probability}, which is the correct option.`,
        topic: 'Classical probability',
        chapter: 'Probability',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Differentiation',
    difficulty: 'hard',
    type: 'numerical',
    make: (rng) => {
      const n = int(rng, 2, 5);
      const a = int(rng, 1, 6);
      const x = int(rng, 1, 4);
      const derivative = a * n * Math.pow(x, n - 1);
      return {
        prompt: `If f(x) = ${a}x^${n}, find the value of f′(${x}).`,
        answer: String(derivative),
        explanation: `f′(x) = ${a}·${n}·x^${n - 1}. Substituting x = ${x} gives f′(${x}) = ${a} × ${n} × ${x}^${n - 1} = ${derivative}.`,
        topic: 'Power rule',
        chapter: 'Differentiation',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Binomial Theorem',
    difficulty: 'hard',
    type: 'mcq',
    make: (rng) => {
      const n = int(rng, 4, 7);
      const r = int(rng, 1, n - 1);
      const binomial = (() => {
        let result = 1;
        for (let i = 1; i <= r; i += 1) result = (result * (n - r + i)) / i;
        return Math.round(result);
      })();
      const { options, answer } = mcq(rng, String(binomial), [`${binomial + 1}`, `${binomial - 1}`, `${n * r}`]);
      return {
        prompt: `In the expansion of (1 + x)^${n}, what is the coefficient of x^${r}?`,
        options,
        answer,
        explanation: `The coefficient of x^${r} is C(${n}, ${r}) = ${binomial}, which is the correct option.`,
        topic: 'Binomial coefficients',
        chapter: 'Binomial Theorem',
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Biology                                                             */
/* ------------------------------------------------------------------ */

const BIOLOGY: Template[] = [
  {
    subject: 'Biology',
    chapter: 'Cell Structure',
    difficulty: 'easy',
    type: 'conceptual',
    make: (rng) => {
      const cells = [
        { organelle: 'Mitochondria', role: 'ATP synthesis (aerobic respiration)', distractors: ['Protein synthesis', 'Photosynthesis', 'Digestion of worn-out organelles'] },
        { organelle: 'Ribosome', role: 'protein synthesis', distractors: ['ATP synthesis', 'Photosynthesis', 'Lipid storage'] },
        { organelle: 'Lysosome', role: 'intracellular digestion', distractors: ['Protein synthesis', 'ATP synthesis', 'Photosynthesis'] },
        { organelle: 'Chloroplast', role: 'photosynthesis', distractors: ['Protein synthesis', 'ATP synthesis in animals', 'Intracellular digestion'] },
      ];
      const chosen = pick(rng, cells);
      const { options, answer } = mcq(rng, chosen.role, chosen.distractors);
      return {
        prompt: `What is the primary function of the ${chosen.organelle} in a cell?`,
        options,
        answer,
        explanation: `The ${chosen.organelle} is responsible for ${chosen.role}, so that option is correct.`,
        topic: 'Cell organelles',
        chapter: 'Cell Structure',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Genetics',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const crosses = [
        { cross: 'TT × tt', ratio: 'all tall (Tt)', distractors: ['3 tall : 1 dwarf', 'all dwarf', '1 tall : 1 dwarf'] },
        { cross: 'Tt × Tt', ratio: '3 tall : 1 dwarf', distractors: ['all tall', '1 tall : 1 dwarf', 'all dwarf'] },
        { cross: 'Tt × tt', ratio: '1 tall : 1 dwarf', distractors: ['3 tall : 1 dwarf', 'all tall', 'all dwarf'] },
      ];
      const chosen = pick(rng, crosses);
      const { options, answer } = mcq(rng, chosen.ratio, chosen.distractors);
      return {
        prompt: `In pea plants, T is the allele for tallness and t for dwarfness. In the cross ${chosen.cross}, what phenotypic ratio appears in the offspring?`,
        options,
        answer,
        explanation: `Working through the Punnett square for ${chosen.cross} gives a phenotypic ratio of ${chosen.ratio}, which is the correct option.`,
        topic: 'Mendelian inheritance',
        chapter: 'Genetics',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Photosynthesis',
    difficulty: 'medium',
    type: 'numerical',
    make: (rng) => {
      const glucose = int(rng, 2, 12);
      const co2 = glucose * 6;
      return {
        prompt: `In photosynthesis, how many molecules of CO₂ are consumed to produce ${glucose} molecules of glucose?`,
        answer: String(co2),
        explanation: `The balanced equation 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂ shows 6 CO₂ per glucose. For ${glucose} glucose molecules the requirement is 6 × ${glucose} = ${co2} molecules of CO₂.`,
        topic: 'Photosynthesis stoichiometry',
        chapter: 'Photosynthesis',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Human Physiology',
    difficulty: 'hard',
    type: 'mcq',
    make: (rng) => {
      const items = [
        { prompt: 'Which part of the nephron is mainly responsible for the reabsorption of glucose?', answer: 'Proximal convoluted tubule', distractors: ['Distal convoluted tubule', 'Loop of Henle', 'Collecting duct'] },
        { prompt: 'Which blood vessel carries oxygenated blood away from the heart?', answer: 'Aorta', distractors: ['Pulmonary artery', 'Vena cava', 'Hepatic portal vein'] },
        { prompt: 'Which enzyme in saliva begins the digestion of starch?', answer: 'Salivary amylase', distractors: ['Pepsin', 'Trypsin', 'Lipase'] },
      ];
      const chosen = pick(rng, items);
      const { options, answer } = mcq(rng, chosen.answer, chosen.distractors);
      return {
        prompt: chosen.prompt,
        options,
        answer,
        explanation: `The correct answer is ${chosen.answer}: ${chosen.answer} performs exactly this role, while the other options belong to different parts of the process.`,
        topic: 'Human physiology',
        chapter: 'Human Physiology',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Ecology',
    difficulty: 'easy',
    type: 'conceptual',
    make: (rng) => {
      const items = [
        { prompt: 'In a food chain, green plants are called', answer: 'producers', distractors: ['consumers', 'decomposers', 'predators'] },
        { prompt: 'The flow of energy in an ecosystem is', answer: 'unidirectional', distractors: ['cyclic', 'bidirectional', 'absent'] },
        { prompt: 'Organisms that break down dead matter are called', answer: 'decomposers', distractors: ['producers', 'herbivores', 'carnivores'] },
      ];
      const chosen = pick(rng, items);
      const { options, answer } = mcq(rng, chosen.answer, chosen.distractors);
      return {
        prompt: `${chosen.prompt} ______.`,
        options,
        answer,
        explanation: `The correct answer is "${chosen.answer}", which is the standard textbook term for this role in an ecosystem.`,
        topic: 'Ecosystem basics',
        chapter: 'Ecology',
      };
    },
  },
];

const PHYSICS_EXTRA: Template[] = [
  {
    subject: 'Physics',
    chapter: 'Motion in a Straight Line',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const u = int(rng, 5, 25);
      const h = (u * u) / 20;
      const nouns = ['A ball', 'A stone', 'A coin', 'A rocket model'];
      const { options, answer } = mcq(rng, `${round(h)} m`, optionsAround(rng, h).map((d) => `${d} m`));
      return {
        prompt: `${pick(rng, nouns)} is thrown vertically upwards with a speed of ${u} m/s. Taking g = 10 m/s², what maximum height does it reach?`,
        options,
        answer,
        explanation: `At the highest point v = 0, so 0 = u² − 2gh gives h = u²/(2g) = ${u}²/(2 × 10) = ${round(h)} m, which is the correct option.`,
        topic: 'Motion under gravity',
        chapter: 'Motion in a Straight Line',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Work, Energy and Power',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const m = int(rng, 20, 120);
      const h = int(rng, 4, 18);
      const t = int(rng, 5, 30);
      const power = (m * 10 * h) / t;
      const { options, answer } = mcq(rng, `${round(power)} W`, optionsAround(rng, power).map((d) => `${d} W`));
      return {
        prompt: `A pump lifts ${m} kg of water through a height of ${h} m in ${t} s. Taking g = 10 m/s², what is the useful power of the pump?`,
        options,
        answer,
        explanation: `Work done = m·g·h = ${m} × 10 × ${h} = ${m * 10 * h} J. Power = work ÷ time = ${m * 10 * h} ÷ ${t} = ${round(power)} W, so that option is correct.`,
        topic: 'Power and work rate',
        chapter: 'Work, Energy and Power',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Waves',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const f = int(rng, 20, 400);
      const lambda = round(0.5 + rng() * 4, 2);
      const v = f * lambda;
      const { options, answer } = mcq(rng, `${round(v)} m/s`, optionsAround(rng, v).map((d) => `${d} m/s`));
      return {
        prompt: `A wave has a frequency of ${f} Hz and a wavelength of ${lambda} m. What is its speed?`,
        options,
        answer,
        explanation: `Wave speed = frequency × wavelength = ${f} × ${lambda} = ${round(v)} m/s, which is the correct option.`,
        topic: 'Wave equation',
        chapter: 'Waves',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Laws of Motion',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const m = round(0.2 + rng() * 2.5, 2);
      const v = int(rng, 6, 25);
      const change = 2 * m * v;
      const { options, answer } = mcq(rng, `${round(change)} kg·m/s`, optionsAround(rng, change).map((d) => `${d} kg·m/s`));
      return {
        prompt: `A ball of mass ${m} kg moving at ${v} m/s hits a wall perpendicularly and rebounds with the same speed. What is the magnitude of the change in its momentum?`,
        options,
        answer,
        explanation: `Momentum reverses, so the change is m·v − (−m·v) = 2mv = 2 × ${m} × ${v} = ${round(change)} kg·m/s — the correct option. Zero (option "0") would be wrong because the direction reverses.`,
        topic: 'Momentum change',
        chapter: 'Laws of Motion',
      };
    },
  },
  {
    subject: 'Physics',
    chapter: 'Thermodynamics',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const mass = int(rng, 50, 500);
      const deltaT = int(rng, 5, 60);
      const q = mass * 4.18 * deltaT;
      const { options, answer } = mcq(rng, `${round(q)} J`, optionsAround(rng, q).map((d) => `${d} J`));
      return {
        prompt: `How much heat is required to raise the temperature of ${mass} g of water by ${deltaT} °C? (specific heat capacity of water = 4.18 J/g°C)`,
        options,
        answer,
        explanation: `Q = m·c·ΔT = ${mass} × 4.18 × ${deltaT} = ${round(q)} J, which is the correct option.`,
        topic: 'Specific heat',
        chapter: 'Thermodynamics',
      };
    },
  },
];

const CHEMISTRY_EXTRA: Template[] = [
  {
    subject: 'Chemistry',
    chapter: 'Some Basic Concepts of Chemistry',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const moles = round(0.5 + rng() * 4, 1);
      const molar = pick(rng, [18, 44, 58.5, 98, 106]);
      const mass = moles * molar;
      const { options, answer } = mcq(rng, `${round(mass)} g`, optionsAround(rng, mass).map((d) => `${d} g`));
      return {
        prompt: `What is the mass of ${moles} mol of a compound whose molar mass is ${molar} g/mol?`,
        options,
        answer,
        explanation: `Mass = moles × molar mass = ${moles} × ${molar} = ${round(mass)} g, which is the correct option.`,
        topic: 'Mole–mass calculations',
        chapter: 'Some Basic Concepts of Chemistry',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Structure of Atom',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const molecules = int(rng, 2, 12);
      const atoms = molecules * 3;
      const { options, answer } = mcq(rng, String(atoms), [`${atoms - 1}`, `${molecules}`, `${atoms + 3}`]);
      return {
        prompt: `How many atoms are present in ${molecules} molecules of CO₂?`,
        options,
        answer,
        explanation: `Each CO₂ molecule has 3 atoms (1 carbon + 2 oxygen), so ${molecules} molecules contain 3 × ${molecules} = ${atoms} atoms — the correct option.`,
        topic: 'Counting atoms',
        chapter: 'Structure of Atom',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Acids, Bases and Salts',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const exponent = int(rng, 1, 7);
      const { options, answer } = mcq(rng, String(exponent), [String(14 - exponent), String(exponent + 1), '7']);
      return {
        prompt: `A solution has a hydrogen ion concentration of 10^(−${exponent}) mol/L. What is its pH?`,
        options,
        answer,
        explanation: `pH = −log₁₀[H⁺] = −log₁₀(10^(−${exponent})) = ${exponent}, which is the correct option.`,
        topic: 'pH calculation',
        chapter: 'Acids, Bases and Salts',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Periodic Classification',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const facts = [
        { q: 'Which element has the largest atomic radius?', a: 'Na', d: ['Cl', 'F', 'Mg'] },
        { q: 'Which element has the highest first ionisation enthalpy?', a: 'He', d: ['Li', 'Na', 'K'] },
        { q: 'Which of these elements is the most electronegative?', a: 'F', d: ['O', 'Cl', 'N'] },
        { q: 'Which element is a metalloid?', a: 'Si', d: ['Na', 'Cl', 'Mg'] },
      ];
      const chosen = pick(rng, facts);
      const { options, answer } = mcq(rng, chosen.a, chosen.d);
      return {
        prompt: chosen.q,
        options,
        answer,
        explanation: `The correct option is ${chosen.a}: periodic trends place ${chosen.a} at that extreme, while the other options belong to different groups or periods.`,
        topic: 'Periodic trends',
        chapter: 'Periodic Classification',
      };
    },
  },
  {
    subject: 'Chemistry',
    chapter: 'Chemical Bonding',
    difficulty: 'hard',
    type: 'mcq',
    make: (rng) => {
      const facts = [
        { q: 'What is the shape of a methane (CH₄) molecule?', a: 'Tetrahedral', d: ['Square planar', 'Trigonal planar', 'Bent'] },
        { q: 'What type of bond is present in NaCl?', a: 'Ionic', d: ['Covalent', 'Metallic', 'Hydrogen'] },
        { q: 'How many lone pairs are on the oxygen atom in a water molecule?', a: '2', d: ['1', '3', '0'] },
        { q: 'Which molecule has a triple bond?', a: 'N₂', d: ['O₂', 'H₂', 'Cl₂'] },
      ];
      const chosen = pick(rng, facts);
      const { options, answer } = mcq(rng, chosen.a, chosen.d);
      return {
        prompt: chosen.q,
        options,
        answer,
        explanation: `Using VSEPR theory and the bonding pattern, the answer is ${chosen.a}; the remaining options describe different geometries or bond types.`,
        topic: 'Bonding and shapes',
        chapter: 'Chemical Bonding',
      };
    },
  },
];

const MATHS_EXTRA: Template[] = [
  {
    subject: 'Mathematics',
    chapter: 'Statistics',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const n = int(rng, 4, 7);
      const values = Array.from({ length: n }, () => int(rng, 10, 90));
      const total = values.reduce((a, b) => a + b, 0);
      const mean = total / n;
      const { options, answer } = mcq(rng, `${round(mean)}`, optionsAround(rng, mean).concat());
      return {
        prompt: `Find the arithmetic mean of the observations ${values.join(', ')}.`,
        options,
        answer,
        explanation: `Mean = sum ÷ number of observations = ${total} ÷ ${n} = ${round(mean)}, which is the correct option.`,
        topic: 'Arithmetic mean',
        chapter: 'Statistics',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Straight Lines',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const x1 = int(rng, -5, 5);
      const y1 = int(rng, -5, 5);
      const dx = int(rng, 1, 6);
      const dy = int(rng, 1, 6);
      const slope = round(dy / dx, 3);
      const { options, answer } = mcq(rng, `${slope}`, [`${round(-slope, 3)}`, `${round(dx / dy, 3)}`, `${round(slope + 1, 3)}`]);
      return {
        prompt: `Find the slope of the line passing through A(${x1}, ${y1}) and B(${x1 + dx}, ${y1 + dy}).`,
        options,
        answer,
        explanation: `Slope = (y₂ − y₁)/(x₂ − x₁) = ${dy}/${dx} = ${slope}, which is the correct option.`,
        topic: 'Slope of a line',
        chapter: 'Straight Lines',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Probability',
    difficulty: 'hard',
    type: 'mcq',
    make: (rng) => {
      const tosses = int(rng, 2, 5);
      const atLeastOnce = round(1 - Math.pow(0.5, tosses), 3);
      const { options, answer } = mcq(rng, `${atLeastOnce}`, [round(Math.pow(0.5, tosses), 3).toString(), '0.5', '1']);
      return {
        prompt: `A fair coin is tossed ${tosses} times. What is the probability of getting at least one head?`,
        options,
        answer,
        explanation: `P(at least one head) = 1 − P(no head) = 1 − (1/2)^${tosses} = ${atLeastOnce}, which is the correct option.`,
        topic: 'Complementary events',
        chapter: 'Probability',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Quadratic Equations',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const b = int(rng, 3, 12);
      const c = int(rng, 1, 9);
      const discriminant = b * b - 4 * c;
      const { options, answer } = mcq(rng, String(discriminant), [`${discriminant + 4}`, `${discriminant - 2}`, `${b * b + 4 * c}`]);
      return {
        prompt: `What is the discriminant of the quadratic equation x² − ${b}x + ${c} = 0?`,
        options,
        answer,
        explanation: `Discriminant = b² − 4ac = (−${b})² − 4(1)(${c}) = ${b * b} − ${4 * c} = ${discriminant}, which is the correct option.`,
        topic: 'Nature of roots',
        chapter: 'Quadratic Equations',
      };
    },
  },
  {
    subject: 'Mathematics',
    chapter: 'Permutations and Combinations',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const n = int(rng, 4, 7);
      const r = 2;
      const value = (n * (n - 1)) / 2;
      const { options, answer } = mcq(rng, String(value), [`${value * 2}`, `${n * n}`, `${value + n}`]);
      return {
        prompt: `In how many ways can ${r} students be selected out of ${n} to form a committee?`,
        options,
        answer,
        explanation: `C(${n}, ${r}) = ${n}!/(${r}!·(${n}−${r})!) = ${value}, so the correct option is ${value}.`,
        topic: 'Combinations',
        chapter: 'Permutations and Combinations',
      };
    },
  },
];

const BIOLOGY_EXTRA: Template[] = [
  {
    subject: 'Biology',
    chapter: 'Genetics',
    difficulty: 'hard',
    type: 'mcq',
    make: (rng) => {
      const facts = [
        { q: 'An individual with the genotype AaBb can produce how many types of gametes?', a: '4', d: ['2', '8', '16'] },
        { q: 'In a dihybrid cross of two heterozygotes, what is the phenotypic ratio in the F2 generation?', a: '9 : 3 : 3 : 1', d: ['3 : 1', '1 : 1', '1 : 2 : 1'] },
        { q: 'Which of the following is a sex-linked disorder?', a: 'Haemophilia', d: ['Colour blindness in both sexes equally', 'Sickle-cell anaemia', 'Phenylketonuria'] },
      ];
      const chosen = pick(rng, facts);
      const { options, answer } = mcq(rng, chosen.a, chosen.d);
      return {
        prompt: chosen.q,
        options,
        answer,
        explanation: `Working from Mendel's laws and the genotype given, the answer is ${chosen.a}, which is the correct option.`,
        topic: 'Mendelian genetics',
        chapter: 'Genetics',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Human Physiology',
    difficulty: 'medium',
    type: 'mcq',
    make: (rng) => {
      const facts = [
        { q: 'What is the normal resting heart rate of a healthy adult human?', a: '72 beats per minute', d: ['120 beats per minute', '20 beats per minute', '200 beats per minute'] },
        { q: 'Which blood group is called the universal donor?', a: 'O negative', d: ['AB positive', 'A positive', 'B negative'] },
        { q: 'Which organ produces bile?', a: 'Liver', d: ['Gall bladder', 'Pancreas', 'Stomach'] },
      ];
      const chosen = pick(rng, facts);
      const { options, answer } = mcq(rng, chosen.a, chosen.d);
      return {
        prompt: chosen.q,
        options,
        answer,
        explanation: `The correct answer is ${chosen.a}; the other options do not match this standard physiological fact.`,
        topic: 'Human physiology',
        chapter: 'Human Physiology',
      };
    },
  },
  {
    subject: 'Biology',
    chapter: 'Photosynthesis',
    difficulty: 'easy',
    type: 'mcq',
    make: (rng) => {
      const facts = [
        { q: 'Which pigment absorbs light energy during photosynthesis?', a: 'Chlorophyll', d: ['Haemoglobin', 'Carotene only', 'Melanin'] },
        { q: 'In which organelle does photosynthesis take place?', a: 'Chloroplast', d: ['Mitochondrion', 'Ribosome', 'Nucleus'] },
        { q: 'Which gas is released during photosynthesis?', a: 'Oxygen', d: ['Carbon dioxide', 'Nitrogen', 'Hydrogen'] },
      ];
      const chosen = pick(rng, facts);
      const { options, answer } = mcq(rng, chosen.a, chosen.d);
      return {
        prompt: chosen.q,
        options,
        answer,
        explanation: `The correct option is ${chosen.a}, which is the standard photosynthesis fact tested here.`,
        topic: 'Photosynthesis basics',
        chapter: 'Photosynthesis',
      };
    },
  },
];

const ALL: Template[] = [
  ...PHYSICS,
  ...PHYSICS_EXTRA,
  ...CHEMISTRY,
  ...CHEMISTRY_EXTRA,
  ...MATHEMATICS,
  ...MATHS_EXTRA,
  ...BIOLOGY,
  ...BIOLOGY_EXTRA,
];

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Turns a draft into the question type the blueprint asked for:
 *  - choice section: keep existing options, or build four options around a numeric answer;
 *  - numerical section: keep a numeric answer, dropping options when the draft was multiple choice.
 * Returns null when the draft cannot honestly be reshaped.
 */
function coerceToType(
  draft: Draft,
  type: ArenaQuestionType,
  rng: Rng,
): { prompt: string; options?: string[]; answer: string; explanation: string } | null {
  const hasOptions = Boolean(draft.options && draft.options.length >= 4);

  if (type === 'numerical') {
    if (!hasOptions) return { prompt: draft.prompt, answer: draft.answer, explanation: draft.explanation };
    const numeric = draft.answer.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
    if (!numeric) return null;
    return { prompt: draft.prompt, answer: numeric[0], explanation: draft.explanation };
  }

  // Choice section (mcq or conceptual).
  if (hasOptions) return { prompt: draft.prompt, options: draft.options, answer: draft.answer, explanation: draft.explanation };

  const numeric = draft.answer.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!numeric) return null;
  const value = Number(numeric[0]);
  const unit = draft.answer.replace(numeric[0], '').trim();
  const distractors = optionsAround(rng, value, 2).map((d) => `${d}${unit ? ` ${unit}` : ''}`);
  const correct = `${numeric[0]}${unit ? ` ${unit}` : ''}`;
  const shuffled = [correct, ...distractors].sort(() => rng() - 0.5);
  return {
    prompt: draft.prompt,
    options: shuffled,
    answer: correct,
    explanation: draft.explanation,
  };
}

function scoreFor(template: Template, query: SampleQuery): number {
  let score = 0;
  if (template.subject.toLowerCase() === query.subject.toLowerCase()) score += 10;
  if (template.type === query.type) score += 4;
  if (template.difficulty === query.difficulty) score += 3;
  if (query.chapters?.length) {
    const wanted = query.chapters.map((c) => c.toLowerCase());
    if (wanted.some((c) => template.chapter.toLowerCase().includes(c) || c.includes(template.chapter.toLowerCase()))) score += 5;
  }
  return score;
}

/**
 * Identity of a generated question: the wording **with its numbers intact**.
 * Parameterised questions deliberately differ only in their values, so stripping digits here would
 * throw away every legitimate variant.
 */
export function exactPromptKey(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kept for callers that need the coarse, numbers-insensitive shape of a question. */
export function promptSignature(prompt: string): string {
  return exactPromptKey(prompt).replace(/\d+/g, '#');
}

/**
 * Produces `count` questions for a slot, drawing from templates in the requested subject and varying
 * the numbers each time. Returns fewer than requested only when the subject genuinely has no
 * templates (the caller then decides what to do).
 */
export function sampleQuestions(query: SampleQuery & { marks: number; negativeMarks: number }): ArenaGeneratedQuestion[] {
  const rng = createRng(query.seed ?? 1);
  const ranked = [...ALL]
    .map((template) => ({ template, score: scoreFor(template, query) }))
    .filter((entry) => entry.score >= 10) // must at least match the subject
    .sort((a, b) => b.score - a.score);

  const pool = ranked.length ? ranked.map((entry) => entry.template) : ALL;
  const out: ArenaGeneratedQuestion[] = [];
  const seen = new Set<string>();

  // Several passes with fresh parameter draws give distinct questions from the same template.
  for (let pass = 0; pass < 24 && out.length < query.count; pass += 1) {
    for (const template of pool) {
      if (out.length >= query.count) break;
      const draft = template.make(rng);
      const key = `${exactPromptKey(draft.prompt)}|${template.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // The blueprint decides the section's type; the template just supplies content, so the draft
      // is coerced to fit: numeric drafts gain options, choice drafts can be reduced to their value.
      const type = query.type;
      const coerced = coerceToType(draft, type, rng);
      if (!coerced) continue;

      out.push({
        prompt: coerced.prompt,
        options: coerced.options,
        answer: coerced.answer,
        explanation: coerced.explanation,
        subject: template.subject,
        topic: draft.topic,
        chapter: draft.chapter,
        difficulty: query.keepTemplateDifficulty ? template.difficulty : query.difficulty,
        type,
        marks: query.marks,
        negativeMarks: query.negativeMarks,
      });
    }
  }

  return out.slice(0, query.count);
}

export const SAMPLE_SUBJECTS = [...new Set(ALL.map((t) => t.subject))];
export const SAMPLE_TEMPLATE_COUNT = ALL.length;
