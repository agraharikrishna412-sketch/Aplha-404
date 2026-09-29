/**
 * Answering in the student's own language — on the model path *and* on the offline sample path.
 *
 * This file exists because of one specific complaint: a student typed
 * "bhai ye loop kyu nahi chal raha?" and was answered in formal English. The model path was given an
 * instruction to mirror the student's language, but the built-in sample engine — the path a student
 * without a provider key actually sees — had no idea what language it was reading and replied with an
 * English lecture. The assistant looked like it had not understood a word.
 *
 * Two things are checked here:
 *  1. detection, including the traps: English sentences that contain a Hindi-looking word ("help me"),
 *     one-word follow-ups that carry no language of their own, and Devanagari mixed with English code;
 *  2. the sample answers themselves, which must change their framing language while leaving code,
 *     keywords and error text in English.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-language-${Date.now()}`);
process.env.JWT_SECRET = 'language-test-secret-not-used-for-anything-real';
process.env.VROQN_MASTER_KEY = 'f'.repeat(64);
process.env.NODE_ENV = 'development';

const { detectStudentLanguage, detectConversationLanguage } = await import('../src/services/ai/language.js');
const { demoCodingAnswer, demoTeachingAnswer } = await import('../src/services/ai/demoBank.js');
const { fallbackLanguageFromSystem, tutorSystem, codeSystem } = await import('../src/services/ai/prompts.js');
const { DEFAULT_SETTINGS } = await import('../src/types/domain.js');

const settings = (language: 'english' | 'hinglish' | 'hindi') => ({ ...DEFAULT_SETTINGS, language });

describe('detecting the language a student wrote in', () => {
  it('reads Roman-script Hindi as Hinglish', () => {
    assert.equal(detectStudentLanguage('bhai ye loop kyu nahi chal raha?'), 'hinglish');
    assert.equal(detectStudentLanguage('mujhe ye samajh nahi aaya'), 'hinglish');
    assert.equal(detectStudentLanguage('iska matlab kya hai?'), 'hinglish');
  });

  it('reads Devanagari as Hindi even when English code is quoted', () => {
    assert.equal(detectStudentLanguage('मेरा loop क्यों नहीं चल रहा?'), 'hindi');
    assert.equal(detectStudentLanguage('for loop में galti कहाँ है'), 'hindi');
  });

  it('leaves English alone', () => {
    assert.equal(detectStudentLanguage('why does my loop stop after one iteration?'), 'english');
    // "me" and "to" are Hindi-ish words too; they must not drag an English sentence into Hinglish.
    assert.equal(detectStudentLanguage('help me debug this function'), 'english');
    assert.equal(detectStudentLanguage('the array is empty'), 'english');
  });

  it('treats an empty message as English rather than guessing', () => {
    assert.equal(detectStudentLanguage(''), 'english');
    assert.equal(detectStudentLanguage('   '), 'english');
    assert.equal(detectStudentLanguage(undefined), 'english');
  });
});

describe('detecting the language of a conversation', () => {
  it('keeps a one-word follow-up in the language already in use', () => {
    assert.equal(detectConversationLanguage(['bhai ye loop kyu nahi chal raha?', 'samjhao']), 'hinglish');
    assert.equal(detectConversationLanguage(['मेरा loop नहीं चल रहा', '?'], 'hindi'), 'hindi');
  });

  it('does not drag an English conversation into Hinglish', () => {
    assert.equal(detectConversationLanguage(['why is my loop slow?', 'ok']), 'english');
  });

  it('falls back to the saved setting only when nothing else says anything', () => {
    assert.equal(detectConversationLanguage(['?'], 'hindi'), 'hindi');
    assert.equal(detectConversationLanguage([], 'hinglish'), 'hinglish');
    assert.equal(detectConversationLanguage(['ok', 'yes'], 'english'), 'english');
  });
});

describe('the saved setting is the fallback, not the rule', () => {
  it('is recoverable from the system prompts this server builds', () => {
    assert.equal(fallbackLanguageFromSystem(codeSystem({ settings: settings('hinglish') }, 'ask')), 'hinglish');
    assert.equal(fallbackLanguageFromSystem(tutorSystem({ settings: settings('hindi') })), 'hindi');
    assert.equal(fallbackLanguageFromSystem(tutorSystem({ settings: settings('english') })), 'english');
    assert.equal(fallbackLanguageFromSystem('no language instruction here'), 'english');
  });

  it('does not override what the student actually typed', () => {
    // Saved setting says English, the student wrote Hinglish: the message wins.
    const prompt = tutorSystem({ settings: settings('english') });
    assert.equal(fallbackLanguageFromSystem(prompt), 'english');
    assert.equal(detectConversationLanguage(['bhai ye chalega?'], fallbackLanguageFromSystem(prompt)), 'hinglish');
  });
});

describe('the offline sample answer still answers in the student\'s language', () => {
  const code = 'for (let i = 0; i <= n; i++) {\n  total += i;\n}';

  it('frames a Hinglish code question in Hinglish and keeps the code in English', () => {
    const reply = demoCodingAnswer({
      mode: 'ask',
      language: 'javascript',
      question: 'bhai ye loop kyu nahi chal raha?',
      code,
      studentLanguage: 'hinglish',
    });
    assert.match(reply, /abhi koi AI key connected nahi hai/i, 'Hinglish framing expected');
    assert.match(reply, /Tumhara sawaal/, 'the student\'s own words are labelled in their language');
    assert.doesNotMatch(reply, /no AI key connected yet/i, 'must not fall back to the English framing');
    // Code and technical labels stay English — that is how students read technical material.
    assert.match(reply, /total \+= i/, 'the submitted code is quoted unchanged');
    assert.match(reply, /Language:\*\* javascript/i);
  });

  it('frames a Devanagari question in Devanagari', () => {
    const reply = demoCodingAnswer({
      mode: 'bugs',
      language: 'python',
      question: 'मेरा loop क्यों नहीं चल रहा?',
      code: 'for i in range(0, n):\n    print(x)',
      studentLanguage: 'hindi',
    });
    assert.match(reply, /अभी कोई AI key जुड़ी नहीं है/, 'Devanagari framing expected on the code path');
    assert.doesNotMatch(reply, /no AI key connected yet/i);
    assert.match(reply, /आपका सवाल/);
    assert.match(reply, /print\(x\)/, 'code stays untouched');
  });

  it('keeps the tutor sample answer in English for an English question', () => {
    const reply = demoTeachingAnswer('why does a body float in water?', 'english');
    assert.match(reply, /Sample answer — no AI key connected yet/);
    assert.doesNotMatch(reply, /abhi koi AI key/i);
  });

  it('mirrors the tutor sample answer for a Hinglish question', () => {
    const reply = demoTeachingAnswer('mujhe float karna samajh nahi aaya', 'hinglish');
    assert.match(reply, /abhi koi AI key connected nahi hai/i);
    assert.match(reply, /Tumhara sawaal/);
    assert.match(reply, /AI Settings/);
  });

  it('introduces the sample in the student\'s language and says the body is English', () => {
    const hinglish = demoTeachingAnswer('mujhe float karna samajh nahi aaya', 'hinglish');
    assert.match(hinglish, /sample library se jawab de raha hai/, 'the opening paragraph mirrors the student');
    assert.match(hinglish, /teaching text English mein hai/, 'the English body is stated plainly, not hidden');

    const hindi = demoTeachingAnswer('मुझे samajh नहीं आया', 'hindi');
    assert.match(hindi, /sample library से उत्तर दे रहा है/);
    assert.match(hindi, /नीचे का teaching text English में है/);
  });

  it('never claims a model produced the sample answer', () => {
    for (const language of ['english', 'hinglish', 'hindi'] as const) {
      const reply = demoCodingAnswer({ mode: 'review', language: 'javascript', code, studentLanguage: language });
      assert.match(reply, /key|Key/, 'the reply must say a key is needed');
      assert.doesNotMatch(reply, /gemini|groq|openrouter/i, 'no provider may be named as the author');
    }
  });
});
