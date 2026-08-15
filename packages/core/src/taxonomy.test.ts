import { describe, expect, it } from 'vitest';
import {
  CAMEO_ROOT,
  CATEGORY_GROUPS,
  CATEGORY_LABELS,
  CATEGORY_LEXICON,
  EVENT_CATEGORIES,
  cameoRootLabel,
  cameoRootToCategory,
  isEventCategory,
} from './taxonomy';

describe('taxonomy completeness', () => {
  it('gives every category a human label', () => {
    // The UI shows the label, never the raw enum. A missing one renders as a
    // snake_case identifier in the feed.
    for (const category of EVENT_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
    }
  });

  it('has no duplicate categories', () => {
    expect(new Set(EVENT_CATEGORIES).size).toBe(EVENT_CATEGORIES.length);
  });

  it('assigns every category to exactly one presentation group', () => {
    // Colour is assigned per group. A category in no group has no colour; a
    // category in two groups gets an arbitrary one.
    const seen = new Map<string, number>();
    for (const group of CATEGORY_GROUPS) {
      for (const category of group.categories) {
        seen.set(category, (seen.get(category) ?? 0) + 1);
      }
    }
    for (const category of EVENT_CATEGORIES) {
      expect(seen.get(category), `${category} group membership`).toBe(1);
    }
  });

  it('keys the lexicon only on real categories', () => {
    for (const key of Object.keys(CATEGORY_LEXICON)) {
      expect(isEventCategory(key), key).toBe(true);
    }
  });

  it('gives every lexicon term a positive weight and no empty strings', () => {
    for (const [category, terms] of Object.entries(CATEGORY_LEXICON)) {
      for (const { term, weight } of terms ?? []) {
        expect(term.trim().length, `${category}: "${term}"`).toBeGreaterThan(0);
        expect(weight, `${category}: "${term}"`).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate terms within a category', () => {
    for (const [category, terms] of Object.entries(CATEGORY_LEXICON)) {
      const list = (terms ?? []).map((t) => t.term.toLowerCase());
      expect(new Set(list).size, category).toBe(list.length);
    }
  });
});

describe('isEventCategory', () => {
  it('accepts known categories and rejects everything else', () => {
    expect(isEventCategory('armed_conflict')).toBe(true);
    expect(isEventCategory('other')).toBe(true);
    expect(isEventCategory('not_a_category')).toBe(false);
    expect(isEventCategory('')).toBe(false);
    expect(isEventCategory(null)).toBe(false);
    expect(isEventCategory(42)).toBe(false);
  });
});

describe('CAMEO mapping', () => {
  it('covers all 20 root codes', () => {
    // GDELT emits EventRootCode 01..20. A gap means those events silently
    // become "other" and lose their category colour and severity weight.
    for (let code = 1; code <= 20; code += 1) {
      const key = String(code).padStart(2, '0');
      expect(CAMEO_ROOT[key], `root ${key}`).toBeDefined();
      expect(cameoRootLabel(key), `root ${key}`).toBeTruthy();
      expect(isEventCategory(cameoRootToCategory(key)), `root ${key}`).toBe(true);
    }
  });

  it('maps the escalation codes to the categories an analyst expects', () => {
    expect(cameoRootToCategory('14')).toBe('civil_unrest'); // protest
    expect(cameoRootToCategory('18')).toBe('armed_conflict'); // assault
    expect(cameoRootToCategory('19')).toBe('armed_conflict'); // fight
    expect(cameoRootToCategory('20')).toBe('terrorism'); // mass violence
    expect(cameoRootToCategory('04')).toBe('diplomacy'); // consult
    expect(cameoRootToCategory('07')).toBe('humanitarian'); // provide aid
  });

  it('accepts unpadded codes, since CSV columns are not reliably padded', () => {
    expect(cameoRootToCategory('4')).toBe(cameoRootToCategory('04'));
    expect(cameoRootLabel('7')).toBe(cameoRootLabel('07'));
  });

  it('degrades to "other" for unknown or missing codes', () => {
    expect(cameoRootToCategory('99')).toBe('other');
    expect(cameoRootToCategory(null)).toBe('other');
    expect(cameoRootToCategory(undefined)).toBe('other');
    expect(cameoRootToCategory('')).toBe('other');
    expect(cameoRootLabel('99')).toBeNull();
  });
});
