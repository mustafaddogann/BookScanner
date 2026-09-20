/**
 * Tests for the per-session Open Library query budget.
 *
 * MAX_TOTAL_QUERIES_PER_SESSION was declared in config but never read, so nothing
 * bounded total network traffic for a scan: candidates resolve sequentially and each
 * can issue up to 5 (pass 1) + 25 (boost) hypothesis queries, so a 30-spine shelf
 * could fire several hundred sequential requests at a 10s timeout each.
 *
 * The budget counts only requests that actually leave the device - cache hits are
 * free - and resets at the start of each resolver run.
 */

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let mockSupabaseConfigured = false;
jest.mock('../../config/supabase', () => ({
  ...jest.requireActual('../../config/supabase'),
  isSupabaseConfigured: () => mockSupabaseConfigured,
  getSupabaseBaseUrl: () => 'https://catalog.test',
  getSupabaseAnonKey: () => 'anon-key',
}));

jest.mock('../../store/useDebugStore', () => ({
  useDebugStore: {
    getState: () => ({ diagnosticsEnabled: false }),
  },
}));

import {
  OpenLibraryProvider,
  clearQueryCache,
  resetSessionQueryBudget,
  getSessionQueryBudget,
} from '../openLibraryProvider';
import { MAX_TOTAL_QUERIES_PER_SESSION } from '../../config/metadataResolutionConfig';

/** Open Library search response with no matches: cheap, and never cached as a hit. */
function emptySearchResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ docs: [], numFound: 0 }),
  };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(emptySearchResponse());
  mockSupabaseConfigured = false;
  clearQueryCache();
});

describe('session query budget', () => {
  it('starts at zero and reports the configured maximum', () => {
    resetSessionQueryBudget();
    expect(getSessionQueryBudget()).toEqual({
      used: 0,
      max: MAX_TOTAL_QUERIES_PER_SESSION,
    });
  });

  it('counts uncached queries as they are issued', async () => {
    resetSessionQueryBudget();
    const provider = new OpenLibraryProvider();

    await provider.searchByEvidence(
      ['THE GUARDIANS', 'JOHN GRISHAM'],
      'THE GUARDIANS',
      'JOHN GRISHAM',
      1
    );

    const { used } = getSessionQueryBudget();
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(MAX_TOTAL_QUERIES_PER_SESSION);
  });

  it('stops issuing network requests once the budget is spent', async () => {
    resetSessionQueryBudget();
    const provider = new OpenLibraryProvider();

    // Burn the budget with genuinely distinct evidence. It has to be alphabetic:
    // hypothesis generation normalises digits away, so "TITLE 1"/"TITLE 2" would
    // collapse to the same query strings and be served from cache for free.
    const words = [
      'ZARQUON', 'BELGRAVE', 'MORDANT', 'PILCROW', 'QUINTAIN', 'SALTIRE',
      'TREMOLO', 'VAMBRACE', 'WITHERS', 'YARROW', 'ZEPHYRS', 'CANTRIP',
      'DULCIMER', 'ESPADRIL', 'FANLIGHT', 'GAMBREL', 'HALYARD', 'IMPASTO',
      'JACQUARD', 'KIRTLE', 'LANYARD', 'MANTILLA', 'NUTHATCH', 'OSSUARY',
      'PARGET', 'QUILLON', 'RAMEKIN', 'SPANDREL', 'TRIVET', 'UMBRAGE',
    ];
    let guard = 0;
    while (getSessionQueryBudget().used < MAX_TOTAL_QUERIES_PER_SESSION && guard < words.length) {
      const a = words[guard];
      const b = words[(guard + 7) % words.length];
      guard++;
      await provider.searchByEvidence([`${a} ${b}`, `${b} ${a}`], `${a} ${b}`, `${b} ${a}`, 1);
    }
    expect(getSessionQueryBudget().used).toBeGreaterThanOrEqual(
      MAX_TOTAL_QUERIES_PER_SESSION
    );

    // Any further candidate must not reach the network at all.
    const callsBefore = mockFetch.mock.calls.length;
    const result = await provider.searchByEvidence(
      ['SOMETHING ENTIRELY NEW', 'ANOTHER PERSON'],
      'SOMETHING ENTIRELY NEW',
      'ANOTHER PERSON',
      1
    );
    expect(mockFetch.mock.calls.length).toBe(callsBefore);

    // It resolves rather than throwing, and says why it found nothing.
    expect(result.scoredCandidates).toEqual([]);
    expect(
      result.hypothesisResults.some((hr) => hr.error === 'session_query_budget_exhausted')
    ).toBe(true);
  });

  it('resetSessionQueryBudget restores the full allowance for the next scan', async () => {
    resetSessionQueryBudget();
    const provider = new OpenLibraryProvider();
    await provider.searchByEvidence(['A TITLE', 'AN AUTHOR'], 'A TITLE', 'AN AUTHOR', 1);
    expect(getSessionQueryBudget().used).toBeGreaterThan(0);

    resetSessionQueryBudget();
    expect(getSessionQueryBudget().used).toBe(0);
  });

  it('does not spend budget on cache hits', async () => {
    resetSessionQueryBudget();
    const provider = new OpenLibraryProvider();
    const evidence = ['REPEATED TITLE', 'REPEATED AUTHOR'];

    await provider.searchByEvidence(evidence, 'REPEATED TITLE', 'REPEATED AUTHOR', 1);
    const afterFirst = getSessionQueryBudget().used;

    // Identical evidence -> identical query hashes -> all served from cache.
    await provider.searchByEvidence(evidence, 'REPEATED TITLE', 'REPEATED AUTHOR', 1);
    expect(getSessionQueryBudget().used).toBe(afterFirst);
  });
});
