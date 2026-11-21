import { describe, expect, it } from 'vitest';
import {
  FULLTEXT_MIN_WORD_LENGTH,
  buildProductSearchQuery,
  buildProductSearchText,
  escapeLikePattern,
} from '../product-search.js';

// Pure helpers: no database, no network.

describe('buildProductSearchText', () => {
  it('joins the name, slug, tags and SKUs into one lowercase haystack', () => {
    expect(buildProductSearchText(['Kilim Rug', 'kilim-rug', 'rug wool', 'RUG-001 RUG-002'])).toBe(
      'kilim rug kilim-rug rug wool rug-001 rug-002',
    );
  });

  it('drops empty parts and collapses whitespace', () => {
    expect(buildProductSearchText(['  Kilim   Rug ', '', null, undefined, 'Wool'])).toBe('kilim rug wool');
  });
});

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards so a user value can only match literally', () => {
    expect(escapeLikePattern('100% wool_rug\\')).toBe('100\\% wool\\_rug\\\\');
  });
});

describe('buildProductSearchQuery', () => {
  it('uses FULLTEXT with +term* for words of 4+ characters', () => {
    expect(buildProductSearchQuery('kilim')).toEqual({ mode: 'fulltext', booleanQuery: '+kilim*' });
    expect(buildProductSearchQuery('hand-woven kilim')).toEqual({
      mode: 'fulltext',
      booleanQuery: '+hand* +woven* +kilim*',
    });
  });

  it('drops words shorter than ft_min_word_len instead of sending them to MySQL', () => {
    // "rug" (3 chars) is invisible to FULLTEXT; the surviving word still searches.
    expect(buildProductSearchQuery('kilim rug')).toEqual({ mode: 'fulltext', booleanQuery: '+kilim*' });
  });

  it('falls back to LIKE when no word is long enough for FULLTEXT', () => {
    expect(buildProductSearchQuery('rug')).toEqual({ mode: 'like', pattern: '%rug%' });
    expect(buildProductSearchQuery('2x3')).toEqual({ mode: 'like', pattern: '%2x3%' });
    expect(buildProductSearchQuery('ab')).toEqual({ mode: 'like', pattern: '%ab%' });
  });

  it('escapes LIKE wildcards in the fallback pattern', () => {
    expect(buildProductSearchQuery('a%b_c')).toEqual({ mode: 'like', pattern: '%a\\%b\\_c%' });
  });

  it('strips boolean-mode operators so user input can never inject boolean syntax', () => {
    expect(buildProductSearchQuery('kilim +rug (test) -"wool"')).toEqual({
      mode: 'fulltext',
      booleanQuery: '+kilim* +test* +wool*',
    });
    expect(buildProductSearchQuery('+kilim*')).toEqual({ mode: 'fulltext', booleanQuery: '+kilim*' });
  });

  it('is case-insensitive (the haystack is lowercase)', () => {
    expect(buildProductSearchQuery('KILIM Rug')).toEqual({ mode: 'fulltext', booleanQuery: '+kilim*' });
  });

  it('exposes the 4-character threshold as a single named constant', () => {
    expect(FULLTEXT_MIN_WORD_LENGTH).toBe(4);
  });
});
