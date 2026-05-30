import { describe, it, expect } from 'vitest';
import { buildContents } from '../src/services/llm/gemini.js';

describe('buildContents', () => {
  it('sem histórico → só a mensagem atual como user', () => {
    expect(buildContents('oi', [])).toEqual([
      { role: 'user', parts: [{ text: 'oi' }] },
    ]);
  });

  it('mapeia bot→model, mantém ordem e põe a mensagem atual por último', () => {
    const history = [
      { role: 'user' as const, text: 'paguei 60 na pizza' },
      { role: 'bot' as const, text: 'quanto foi?' },
    ];
    expect(buildContents('com a Ana', history)).toEqual([
      { role: 'user', parts: [{ text: 'paguei 60 na pizza' }] },
      { role: 'model', parts: [{ text: 'quanto foi?' }] },
      { role: 'user', parts: [{ text: 'com a Ana' }] },
    ]);
  });
});
