import { describe, expect, it } from 'vitest';
import { planTypeFromClaims } from '../src/chatgpt/oauth.js';

describe('planTypeFromClaims', () => {
  it('reads the nested OpenAI auth claim and the top-level fallback', () => {
    expect(planTypeFromClaims({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'Free' } })).toBe('free');
    expect(planTypeFromClaims({ chatgpt_plan_type: 'plus' })).toBe('plus');
  });
  it('returns undefined when missing or malformed', () => {
    expect(planTypeFromClaims({})).toBeUndefined();
    expect(planTypeFromClaims({ chatgpt_plan_type: '<script>' })).toBeUndefined();
  });
});
