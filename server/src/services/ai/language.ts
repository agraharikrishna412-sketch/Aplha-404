/**
 * Which language is the student writing in?
 *
 * The model path mirrors the student's language through an instruction (`MIRROR_RULE` in
 * `prompts.ts`). The offline sample path cannot follow an instruction, so it needs to *detect* the
 * language and answer in it — otherwise a student who types Hinglish and has no provider key
 * connected reads a formal English sample and concludes, quite reasonably, that the assistant did
 * not understand a word of their question.
 *
 * Detection is intentionally simple and explainable: script first, then a small list of Roman-script
 * Hindi markers. Nothing here is a language model, and nothing here is applied to English text.
 */

export type StudentLanguage = 'english' | 'hinglish' | 'hindi';

/** Anything in the Devanagari block means the student wrote Hindi (possibly mixed with English terms). */
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Roman-script Hindi markers.
 *
 * Short, ambiguous words ("me", "to", "na", "ka" on their own) are deliberately left out: "help me
 * debug this" is English, and a false positive here would answer an English question in Hinglish.
 * Two distinct markers are required, which is well below what a real Hinglish sentence contains
 * ("bhai ye loop kyu nahi chal raha" scores seven).
 */
const HINGLISH_MARKERS = new Set([
  'aayega',
  'accha',
  'achha',
  'aata',
  'aur',
  'bata',
  'batao',
  'bhai',
  'behen',
  'bekar',
  'bhar',
  'bolo',
  'chahiye',
  'chal',
  'chalta',
  'dekh',
  'dekho',
  'dikha',
  'dobara',
  'galti',
  'hai',
  'hain',
  'hoga',
  'hota',
  'hua',
  'iska',
  'isme',
  'kaam',
  'kaise',
  'karo',
  'karna',
  'kuch',
  'kya',
  'kyu',
  'kyun',
  'kyunki',
  'lagta',
  'lekin',
  'likha',
  'matlab',
  'mein',
  'mujhe',
  'nahi',
  'nahin',
  'phir',
  'raha',
  'rahi',
  'samajh',
  'samjha',
  'samjhao',
  'sawaal',
  'se',
  'tha',
  'theek',
  'thik',
  'tumhara',
  'uska',
  'wala',
  'ye',
  'yeh',
  'zara',
]);

/**
 * Detect the language of one student message.
 *
 * Order matters: Devanagari wins outright, because a Hindi sentence that quotes English code is
 * still a Hindi sentence.
 */
export function detectStudentLanguage(text: string | undefined | null): StudentLanguage {
  const value = (text ?? '').trim();
  if (!value) return 'english';
  if (DEVANAGARI.test(value)) return 'hindi';

  const words = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const markers = new Set(words.filter((word) => HINGLISH_MARKERS.has(word)));
  return markers.size >= 2 ? 'hinglish' : 'english';
}

/**
 * Continue an existing conversation in the language it is already using.
 *
 * A one-word follow-up ("iska matlab?", "samjhao", even "?") carries no language on its own; the
 * honest reading is "keep using whatever we were using". Only when nothing earlier says anything do
 * we fall back to the saved preference.
 */
export function detectConversationLanguage(
  messages: (string | undefined | null)[],
  fallback: StudentLanguage = 'english',
): StudentLanguage {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const detected = detectStudentLanguage(messages[index]);
    if (detected !== 'english') return detected;
    // A message that is plainly English (not just too short to tell) ends the search.
    const value = (messages[index] ?? '').trim();
    if (/\b(the|is|are|why|how|what|does|should|please|help|code|error|loop|function)\b/i.test(value)) {
      return 'english';
    }
  }
  return fallback;
}

export interface SampleVoice {
  /** Opening paragraph of a sample teaching answer, written in the student's language. */
  intro: string;
  /** States plainly, in the student's language, that the sample body itself is in English. */
  bodyNote: string;
  /** Heading on the sample answer. */
  heading: string;
  /** Same heading, in the form that appends to a task name ("Code review — <suffix>"). */
  headingSuffix: string;
  /** One-line statement that no model is connected. */
  notice: string;
  /** Label above the student's quoted question. */
  yourQuestion: string;
  /** Label above the "do this while waiting" block. */
  whileYouWait: string;
  /** Closing sentence of every sample answer. */
  footer: string;
  /** Sentence explaining the sample path is a stand-in for a real key. */
  connectHint: string;
}

/**
 * Presentation strings for the sample engine, in the student's language.
 *
 * Only the framing is translated. Headings, numbered steps, code and error text stay in English:
 * that is how these students actually read technical material, and translating `console.log` would
 * make the sample harder to use, not friendlier.
 */
const VOICES: Record<StudentLanguage, SampleVoice> = {
  english: {
    headingSuffix: 'no AI key connected yet',
    heading: 'Sample answer — no AI key connected yet',
    notice: 'A model is not connected, so this is the built-in sample reply. It follows the structure a real answer will use.',
    yourQuestion: 'Your question',
    whileYouWait: 'While you wait',
    footer: 'Your program still runs in the Output panel regardless of the AI connection, so you can keep testing code right now.',
    connectHint: 'Add your own key in AI Settings for a full answer about your actual work.',
    bodyNote: 'The teaching text below is in English; with a key connected the whole answer comes in the language you write in.',
    intro: 'Vroqn Nexus is answering from its built-in sample library right now, so this reply follows the same structure a real model reply will use: concept first, then a worked example, then a quick check you can attempt.',
  },
  hinglish: {
    headingSuffix: 'abhi koi AI key connected nahi hai',
    heading: 'Sample answer — abhi koi AI key connected nahi hai',
    notice:
      'Abhi koi model connected nahi hai, isliye ye built-in sample reply hai. Isme wahi structure hai jo real answer mein milega.',
    yourQuestion: 'Tumhara sawaal',
    whileYouWait: 'Jab tak reply aaye',
    footer:
      'Output panel mein code chalega chahe AI connected ho ya nahi, to tum abhi bhi testing kar sakte ho.',
    connectHint: 'AI Settings mein apni key add karo, tab tumhare actual code ka poora answer milega.',
    bodyNote: 'Neeche ka teaching text English mein hai — key jodne par poora jawab usi bhasha mein milega jisme tum likhte ho.',
    intro: 'Abhi Vroqn Nexus apni built-in sample library se jawab de raha hai, isliye ye reply wahi structure follow karta hai jo real model ka hoga: pehle concept, phir worked example, phir ek quick check jo tum khud try kar sakte ho.',
  },
  hindi: {
    headingSuffix: 'अभी कोई AI key जुड़ी नहीं है',
    heading: 'नमूना उत्तर — अभी कोई AI key जुड़ी नहीं है',
    notice:
      'अभी कोई model जुड़ा नहीं है, इसलिए यह built-in sample reply है। इसमें वही structure है जो असली उत्तर में मिलेगा।',
    yourQuestion: 'आपका सवाल',
    whileYouWait: 'जब तक उत्तर आए',
    footer:
      'Output panel में code चलेगा, AI जुड़ा हो या न हो — इसलिए आप अभी भी testing कर सकते हैं।',
    connectHint: 'AI Settings में अपनी key जोड़िए, तब आपके असली code का पूरा उत्तर मिलेगा।',
    bodyNote: 'नीचे का teaching text English में है — key जोड़ने पर पूरा उत्तर उसी भाषा में मिलेगा जिसमें आप लिखते हैं।',
    intro: 'अभी Vroqn Nexus अपनी built-in sample library से उत्तर दे रहा है, इसलिए यह reply वही structure follow करता है जो असली model का होगा: पहले concept, फिर worked example, फिर एक quick check जो आप खुद try कर सकते हैं।',
  },
};

export function sampleVoice(language: StudentLanguage): SampleVoice {
  return VOICES[language];
}
