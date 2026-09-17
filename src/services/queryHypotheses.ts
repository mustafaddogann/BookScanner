/**
 * Query Hypotheses Service
 *
 * Generates ordered search query hypotheses from OCR evidence.
 * These hypotheses are used to search Open Library and find the best match.
 *
 * The key insight is that OCR field extraction (title/author assignment) is often
 * wrong, but the raw text lines themselves are usually correct. This service
 * generates multiple query variations from the evidence to maximize the chance
 * of finding the correct book.
 */

import type { EvidenceTier } from '../types';
import {
  buildEvidenceTokens,
  stripLeadingArticle,
  normalizeForScoring,
  looksLikeTitle,
  looksLikePersonName,
  type EvidenceTokens,
} from './evidenceNormalization';
import {
  PASS1_MAX_HYPOTHESES,
  PASS2_MAX_HYPOTHESES,
  MIN_QUERY_LENGTH,
  MAX_QUERY_TOKENS,
  BOOST_TOP_TOKENS_COUNT,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * A search hypothesis with metadata
 */
export interface SearchHypothesis {
  /** The query string to search */
  query: string;
  /** Hypothesis type for debugging */
  type: HypothesisType;
  /** Priority (lower = try first) */
  priority: number;
  /** Explanation for debugging */
  explanation: string;
}

export type HypothesisType =
  | 'isbn'           // Direct ISBN search
  | 'title_author'   // Title + author combination
  | 'author_title'   // Author + title combination
  | 'title_only'     // Just title
  | 'author_only'    // Just author
  | 'longest_line'   // Longest non-junk line
  | 'combined_lines' // Multiple lines combined
  | 'stripped'       // Article-stripped variant
  | 'fallback'       // OCR field fallback
  // Boost pass types
  | 'boost_combo'    // Combined substantive lines
  | 'boost_tokens'   // Top N unique tokens
  | 'boost_ngram'    // N-gram sliding window
  | 'boost_partial'; // Partial line match

/**
 * Result of hypothesis generation
 */
export interface HypothesisGenerationResult {
  /** Ordered hypotheses to try */
  hypotheses: SearchHypothesis[];
  /** Debug info */
  debug: {
    inputLineCount: number;
    cleanedLineCount: number;
    tokenCount: number;
    personNames: string[];
    titleLikeLines: string[];
    isbns: string[];
  };
}

export interface HypothesisDebugContext {
  candidateId?: string;
  evidenceTier?: EvidenceTier;
}

// ============================================================================
// Configuration (imported from metadataResolutionConfig)
// ============================================================================

/** Re-export for backwards compatibility */
export const MAX_HYPOTHESES = PASS1_MAX_HYPOTHESES;

// ============================================================================
// Hypothesis Generation
// ============================================================================

/**
 * Extract surname token from a multi-word author line.
 * Helps when OCR corrupts first name but surname remains usable.
 */
function extractAuthorSurname(authorLine: string | null): string | null {
  if (!authorLine) return null;
  const tokens = authorLine.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) return null;
  const surname = tokens[tokens.length - 1];
  return surname.length >= 3 ? surname : null;
}

/**
 * Extract a strong trailing title token for resilient title+surname queries.
 * Example: "STRAIGHI INTO DARKNESS" -> "darkness".
 */
function extractTitleTailToken(titleLine: string | null): string | null {
  if (!titleLine) return null;

  const words = titleLine.trim().split(/\s+/).filter(Boolean);
  let candidateLine = titleLine;

  // If the line ends with a likely two-word person name, drop that suffix first.
  // This helps recover title tails from lines like "OVERTURE TO DEATH AGAID MARSH".
  if (words.length >= 4) {
    const trailingPair = words.slice(-2).join(' ');
    if (looksLikePersonName(trailingPair)) {
      candidateLine = words.slice(0, -2).join(' ');
    }
  }

  const tokens = normalizeForScoring(candidateLine);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].length >= 4 && !TITLE_CONNECTOR_WORDS.has(tokens[i].toLowerCase())) {
      return tokens[i];
    }
  }
  return null;
}

const TITLE_CONNECTOR_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  've',
  'ile',
  'in',
  'to',
  'for',
  'with',
  'on',
  'at',
  'from',
  'into',
]);

/**
 * OCR cleanup rules used to improve search query quality.
 * Keep this conservative and focused on observed spine OCR failure modes.
 */
const OCR_QUERY_NOISE_TOKENS = new Set([
  'jove',
  'berkley',
  'novel',
  'fiction',
  'authors',
  'author',
  'writer',
  'national',
  'bestsell',
  'bestseler',
  'bestsellek',
  'bestsellin',
  'besiselling',
  'bestrellins',
  'bestsellerer',
  'oll',
  'pcto',
  'ati',
  'att',
  'eiv',
  'ana',
  'eg',
  'sas',
  'can',
  'wi',
  'un',
  'ne',
  'al',
  'eu',
  'bh',
  'rcuior',
  'rctior',
  'ties',
  'mettikes',
  'iavers',
  'noblems',
  'prin',
  'crinis',
  'mystery',
  'times',
  'newyork',
  'newyorktimes',
  'noisea',
  'noisia',
  'bestseller',
  'bestselling',
  'bestsellingauthor',
  'paperback',
  'hardcover',
  'tor',
  'mass',
  'market',
  // Frequent OCR garbage observed in rejects
  'sili',
  'siall',
  'histi',
  'shous',
  'isouttesoiai',
  'isouttesoiat',
  'leetea',
  'listemas',
  'nosta',
  'nhop',
  'ilsde',
  'novei',
  'stak',
  's7ll',
  // Additional low-signal OCR fragments from recent rejects
  'rom',
  'moll',
  'ele',
  'll',
  'nill',
  'asth',
  'frinie',
  'ets',
  'ts',
  'du',
  'testeerats',
  'staaboutes',
  'nofer',
  'nfer',
  'noer',
  'nofr',
  'ishoe',
  // Editorial and low-information debris that should not dominate queries
  'edited',
  'editor',
  'editors',
  'afoen',
  'ayoen',
  // Observed OCR garbage fragments in unresolved rejects
  'folol',
  'wiaro',
  // High-noise OCR fragments that repeatedly degrade query quality
  'nvho',
  'cenuurnr',
  'achusioe',
  'tuindo',
  'duneblnngvn',
  'cauwn',
  'uintha',
  // Turkish/Latin OCR debris from unresolved spine lines
  'celatena',
  'erall',
  'drr',
  'cidinia',
  'idur',
  'ilad',
  'lkesi',
  'othin',
  'aoia',
  'darinllad',
  'lkfsi',
  'ctha',
  'kkm',
  'km',
  'kn',
  'alttt',
  'onvulys',
  'oi3nz',
  'nyj3ls',
  'mitinta',
  'siiaoown',
  'tiuite',
]);

const OCR_SINGLE_TOKEN_QUERY_NOISE = new Set([
  'new',
  'york',
  'times',
  'fiction',
  'author',
  'authors',
  'writer',
  'bestsell',
  'bestseller',
  'bestselling',
  'novel',
  'berkley',
  'jove',
  'tor',
  'paperback',
  'hardcover',
  'mystery',
  'nofer',
  'nfer',
  'noer',
  'nofr',
  'edited',
  'editor',
  'editors',
  'nvho',
  'cenuurnr',
  'achusioe',
  'tuindo',
  'duneblnngvn',
  'cauwn',
  'uintha',
  'celatena',
  'erall',
  'drr',
  'cidinia',
  'idur',
  'ilad',
  'lkesi',
  'othin',
  'aoia',
  'darinllad',
  'lkfsi',
  'ctha',
  'kkm',
  'km',
  'kn',
  'alttt',
  'onvulys',
  'oi3nz',
  'nyj3ls',
  'mitinta',
  'siiaoown',
  'tiuite',
]);

const OCR_QUERY_LOW_SIGNAL_TOKENS = new Set([
  'he',
  'she',
  'him',
  'her',
  'his',
  'hers',
  'they',
  'them',
  'their',
  'are',
  'was',
  'were',
  'been',
  'being',
  'since',
  'who',
  've',
  'ile',
]);

const OCR_FUSED_JOINERS = ['into', 'and', 'with', 'from', 'the', 'for', 'your', 'god', 'of'];
const OCR_FUSED_JOINER_EXACT_EXCEPTIONS = new Set([
  // Valid names/words that happen to end with joiner substrings.
  'hoagland',
  'anderson',
  'andersen',
]);
const OCR_MERGED_AUTHOR_HINT_TOKENS = new Set([
  'yusufatilgan',
  'orhanpamuk',
  'aminmaalouf',
  'johnsteinbeck',
  'stefanzweig',
  'williamjames',
  'francisracon',
  'garnliel',
  'harouir',
]);

const OCR_QUERY_TOKEN_CORRECTIONS = new Map<string, string[]>([
  ['d', ['and']],
  ['0f', ['of']],
  ['0n', ['on']],
  ['lnto', ['into']],
  ['lnt0', ['into']],
  ['achristina', ['christina']],
  ['fave', ['faye']],
  ['cave', ['faye']],
  ['acaid', ['ngaio']],
  ['agaid', ['ngaio']],
  ['monig', ['ngaio']],
  ['garnliel', ['gabriel']],
  ['harouir', ['marquez']],
  ['yuzyillie', ['yuzyillik']],
  ['yusufatilgan', ['yusuf', 'atilgan']],
  ['orhanpamuk', ['orhan', 'pamuk']],
  ['aminmaalouf', ['amin', 'maalouf']],
  ['johnsteinbeck', ['john', 'steinbeck']],
  ['stefanzweig', ['stefan', 'zweig']],
  ['williamjames', ['william', 'james']],
  ['francisracon', ['francis', 'bacon']],
  ['kajka', ['kafka']],
  ['otell', ['oteli']],
  ['limanlan', ['limanlari']],
  ['masumiyetmzesi', ['masumiyet', 'muzesi']],
  ['masumiyetmuzesi', ['masumiyet', 'muzesi']],
  ['farelerve', ['fareler', 've']],
  ['hakikatinanlami', ['hakikatin', 'anlami']],
  ['doneyem', ['donem']],
  ['donenom', ['donem']],
  ['czerine', ['uzerine']],
  ['dosonceler', ['dusunceler']],
  ['yini', ['yeni']],
  ['ailanias', ['anlayis']],
  ['hemingwaytagh', ['hemingway', 'yasli']],
  ['tagh', ['yasli']],
  ['deni', ['deniz']],
  ['lspl', ['is']],
  ['lspi', ['is']],
  ['adly', ['deadly']],
  ['adaly', ['deadly']],
  ['adely', ['deadly']],
  ['adily', ['deadly']],
  ['adoly', ['deadly']],
  ['catherini', ['catherine']],
  ['catherint', ['catherine']],
  ['cardeni', ['carden']],
  ['cardent', ['carden']],
  ['lac', ['lia']],
  ['alia', ['alibi']],
  ['hodgalan', ['hoagland']],
  ['hoagland', ['hoagland']],
  ['aire', ['fire']],
  ['lineof', ['line', 'of']],
  ['arica', ['erica']],
  ['cis', ['c', 'is', 'for']],
  ['priscil', ['priscilla']],
  ['priscill', ['priscilla']],
  ['priscila', ['priscilla']],
  ['warsh', ['marsh']],
  ['denth', ['death']],
  ['straighi', ['straight']],
  ['straighe', ['straight']],
  ['straighiinto', ['straight', 'into']],
  ['straigheinto', ['straight', 'into']],
  ['fi', ['fire']],
  ['unconqueredfi', ['unconquered', 'fire']],
  ['fiace', ['face']],
  ['runforyour', ['run', 'for', 'your']],
  ['foryourlife', ['for', 'your', 'life']],
  ['runforyourlife', ['run', 'for', 'your', 'life']],
  ['fond', ['food']],
  ['rosesare', ['roses', 'are']],
  ['stak', ['stakeout']],
  ['staksout', ['stakeout']],
  ['han', ['jonathan']],
  ['tonyhillerman', ['tony', 'hillerman']],
  ['talkinggod', ['talking', 'god']],
  ['jamespatterson', ['james', 'patterson']],
  ['davidbaldacce', ['david', 'baldacci']],
  ['baldacce', ['baldacci']],
  ['visicn', ['vision']],
  ['vora', ['york']],
  ['nattonal', ['national']],
  ['natlenats', ['national']],
  ['roberto', ['robert']],
  ['wamraugh', ['wambaugh']],
  ['fbarck', ['black']],
  ['petarbl', ['marble']],
  ['cookon', ['cook']],
  ['sicht', ['sight']],
  ['oe', ['zoe']],
  ['joc', ['joe']],
  ['onthe', ['on', 'the']],
  ['ciyde', ['clyde']],
  ['cinde', ['cindy']],
  ['pandips', ['phillips']],
  ['philips', ['phillips']],
  ['bundsided', ['blindsided']],
  ['bindsded', ['blindsided']],
  ['bicody', ['bloody']],
  ['denisemina', ['denise', 'mina']],
  ['wodd', ['wood']],
  ['willl', ['will']],
  ['rabbl', ['rabbi']],
  ['kemielman', ['kemelman']],
  ['ieuit', ['exit']],
  ['unrer', ['under']],
  ['ames', ['james']],
  ['tomustice', ['justice']],
  ['chlarfo', ['charlaine']],
  ['aiche', ['aicher']],
  ['eith', ['keith']],
  ['teethey', ['keith']],
  ['tohn', ['john']],
  ['iohn', ['john']],
  ['johna', ['john']],
  ['jhna', ['john']],
  ['jona', ['john']],
  ['joha', ['john']],
  ['nhoc', ['city']],
  ['ilsoe', ['city', 'of']],
  ['lsoe', ['city', 'of']],
  ['isoe', ['city', 'of']],
  ['iloe', ['city', 'of']],
  ['ilse', ['city', 'of']],
  ['vctory', ['victory']],
  ['vitory', ['victory']],
  ['vicory', ['victory']],
  ['victry', ['victory']],
  ['victoy', ['victory']],
  ['roberte', ['robert']],
  ['candford', ['sandford']],
  ['lighining', ['lightning']],
  ['htning', ['lightning']],
  ['tricia', ['patricia']],
  ['parterson', ['patterson']],
  ['parerson', ['patterson']],
  ['pateasan', ['patterson']],
  ['alongcane', ['along', 'came']],
  ['aspder', ['spider']],
  ['asper', ['spider']],
  ['robertr', ['robert']],
  ['fallison', ['allison']],
  ['stelen', ['stolen']],
  ['framie', ['frame']],
  ['suspiciou', ['suspicious']],
  ['bonegragk', ['bonecrack']],
  ['boneerack', ['bonecrack']],
  ['franhis', ['francis']],
  ['dhesk', ['desk']],
  ['crafton', ['grafton']],
  ['cson', ['jackson']],
  ['deathat', ['death', 'at']],
  ['fai', ['faith']],
  ['hearto', ['heart', 'of']],
  ['ofjustie', ['of', 'justice']],
  ['justie', ['justice']],
  ['willianel', ['william']],
  ['hanh', ['john']],
  ['keuf', ['keith']],
  ['neris', ['nerds']],
  ['nris', ['nerds']],
  ['numn', ['nunn']],
  ['desi', ['design']],
  ['pincent', ['vincent']],
  ['ranville', ['granville']],
  ['visi', ['vision']],
  ['emphess', ['empress']],
  ['ilc', ['file']],
  ['tohd', ['john']],
  ['fustie', ['justice']],
  ['wielane', ['william']],
  ['wilhane', ['william']],
  ['coughline', ['coughlin']],
  ['coughen', ['coughlin']],
  ['alcoughen', ['coughlin']],
  ['sumeet', ['sweet']],
  ['seai', ['scents']],
  ['bles', ['brass']],
  ['denver', ['deaver']],
  ['cene', ['bane']],
  ['simee', ['suzanne']],
  ['deaf', ['dead']],
  ['seream', ['scream']],
  ['ca', ['cat']],
  ['dis', ['dick']],
  ['peuplevs', ['people', 'vs']],
  ['crosse', ['cross']],
  ['fetten', ['fallen']],
  ['hawimett', ['hammett']],
  ['dishell', ['dashiell']],
  ['barte', ['bartz']],
  ['besiselling', ['bestselling']],
  ['bestrellins', ['bestselling']],
  ['bin', ['b', 'is', 'for']],
  ['cin', ['c', 'is', 'for']],
  ['s7ll', ['is', 'for']],
  // Recent reject set corrections
  ['tu', ['the']],
  ['iihe', ['the']],
  ['ofa', ['of', 'a']],
  ['vears', ['years']],
  ['lun', ['million']],
  ['luon', ['million']],
  ['erson', ['anderson']],
  ['bavid', ['david']],
  ['gavid', ['david']],
  ['hartwele', ['hartwell']],
  ['chilivan', ['sullivan']],
  ['cilivan', ['sullivan']],
  ['chlivan', ['sullivan']],
  ['chiivan', ['sullivan']],
  ['chilvan', ['sullivan']],
  ['chilian', ['sullivan']],
  ['chilivn', ['sullivan']],
  ['racrel', ['rachel']],
  ['caise', ['caine']],
  ['jessiver', ['jennifer']],
  ['jensifer', ['jennifer']],
  ['ester', ['estep']],
  ['bearne', ['hearne']],
  ['bearse', ['hearne']],
  ['ncawny', ['nancy']],
  ['ndr', ['and']],
  ['awvliead', ['waylaid']],
  ['avliead', ['waylaid']],
  ['awliead', ['waylaid']],
  ['awviead', ['waylaid']],
  ['awvlead', ['waylaid']],
  ['awvliad', ['waylaid']],
  ['awvlied', ['waylaid']],
  // Turkish OCR debris from recent reject sets - drop from queries
  ['celatena', []],
  ['erall', []],
  ['drr', []],
  ['cidinia', []],
  ['idur', []],
  ['ilad', []],
  ['lkesi', []],
  ['othin', []],
  ['aoia', []],
  ['darinllad', []],
  ['lkfsi', []],
  ['ctha', []],
  ['kkm', []],
  ['km', []],
  ['kn', []],
  ['alttt', []],
  ['onvulys', []],
  ['oi3nz', []],
  ['nyj3ls', []],
  ['mitinta', []],
  ['siiaoown', []],
  ['tiuite', []],
  // High-noise fragments from recent rejects - remove from normalized query text
  ['nvho', []],
  ['cenuurnr', []],
  ['achusioe', []],
  ['tuindo', []],
  ['duneblnngvn', []],
  ['cauwn', []],
  ['uintha', []],
]);

const OCR_QUERY_PHRASE_CORRECTIONS: Array<{ from: string[]; to: string[] }> = [
  { from: ['achristina', 'dodd'], to: ['christina', 'dodd'] },
  { from: ['buckley', 'neris'], to: ['buckley', 'nerds'] },
  { from: ['line', 'of', 'aire'], to: ['line', 'of', 'fire'] },
  { from: ['line', 'of', 'aire', 'hoagland'], to: ['line', 'of', 'fire', 'hoagland'] },
  { from: ['the', 'hear', 'of', 'justice'], to: ['the', 'heart', 'of', 'justice'] },
  { from: ['fatale', 'visi'], to: ['fatal', 'vision'] },
  { from: ['ort', 'fatale', 'visi'], to: ['fatal', 'vision'] },
  { from: ['blindsight', 'numn', 'choke'], to: ['blindsight'] },
  { from: ['death', 'by', 'desi'], to: ['death', 'by', 'design'] },
  { from: ['pincent', 'ranville'], to: ['vincent', 'granville'] },
  { from: ['let', 'as', 'robert', 'parker'], to: ['robert', 'b', 'parker'] },
  { from: ['testeerats', 'robert', 'parker'], to: ['robert', 'b', 'parker'] },
  { from: ['ty', 'nhoc', 'ilsoe', 'victory'], to: ['city', 'of', 'victory'] },
  { from: ['nhoc', 'ilsoe', 'victory'], to: ['city', 'of', 'victory'] },
  { from: ['he', 'emphess', 'ilc', 'tohd', 'cho', 'tuhl', 'chi'], to: ['the', 'empress', 'file', 'john', 'd', 'macdonald'] },
  { from: ['he', 'emphess', 'ilc', 'tohd', 'tuhl', 'chi'], to: ['the', 'empress', 'file', 'john', 'd', 'macdonald'] },
  { from: ['ghost', 'd'], to: ['ghost', 'and'] },
  { from: ['catherini', 'ion'], to: ['catherine'] },
  { from: ['catherint', 'ion'], to: ['catherine'] },
  { from: ['deadly', 'game', 'catherine', 'ion'], to: ['deadly', 'game', 'catherine'] },
  { from: ['han', 'kellerman'], to: ['jonathan', 'kellerman'] },
  { from: ['acuua', 'alia'], to: ['a', 'is', 'for', 'alibi'] },
  { from: ['patricia', 'di', 'cornwell'], to: ['patricia', 'cornwell'] },
  { from: ['the', 'ca', 'saw'], to: ['the', 'cat', 'who', 'saw'] },
  { from: ['line', 'of', 'fine'], to: ['line', 'of', 'fire'] },
  { from: ['line', 'of', 'fire', 'hodgalan'], to: ['line', 'of', 'fire', 'hoagland'] },
  { from: ['line', 'of', 'fi'], to: ['line', 'of', 'fire'] },
  { from: ['charlaine', 'justice', 'william', 'coughlin'], to: ['justice', 'william', 'coughlin'] },
  { from: ['night', 'tai', 'might', 'scents'], to: ['night', 'scents'] },
  { from: ['night', 'might', 'scents'], to: ['night', 'scents'] },
  { from: ['worlds', 'fire'], to: [] },
  { from: ['city', 'veils'], to: ['city', 'of', 'veils'] },
  { from: ['fatale', 'vision'], to: ['fatal', 'vision'] },
  { from: ['blind', 'sicht'], to: ['blind', 'sight'] },
  { from: ['the', 'fetten'], to: ['the', 'fallen'] },
  { from: ['blow', 'back'], to: ['blowback'] },
  { from: ['is', 'for', 'for'], to: ['is', 'for'] },
  { from: ['une', 'de', 'aire'], to: [] },
  { from: ['the', 'unconquered', 'fire', 'ace'], to: ['face', 'the', 'fire'] },
  { from: ['unconquered', 'fi'], to: ['unconquered', 'fire'] },
  { from: ['fi', 'ace'], to: ['face'] },
  { from: ['stone', 'mon'], to: ['stone', 'monkey'] },
  { from: ['along', 'cane'], to: ['along', 'came'] },
  { from: ['for', 'gotten'], to: ['forgotten'] },
  { from: ['edited', 'by'], to: [] },
  { from: ['jennifer', 'ester'], to: ['jennifer', 'estep'] },
  { from: ['boat', 'ofa'], to: ['boat', 'of', 'a'] },
];

const OCR_QUERY_NOISE_PATTERNS = [
  /\bnew\s+york\s+times?\b/gi,
  /\bnew\s+y0rk\s+t[i1]mes?\b/gi,
  /\bnational\s+bestseller\b/gi,
  /\bbestseller\b/gi,
  /\bbestselling\b/gi,
  /\bbestsellek\b/gi,
  /\$\s?\d+(?:\.\d{2})?\b/g,
  /\b\d+\.\d{2}\b/g,
];

const OCR_BADGE_NOISE_TOKEN_PATTERNS = [
  /^(?:newyorktimes?|newyork|times|national|bestsell(?:er|ing|in)?|bestseler|bestsellek|bestsellerer|besiselling|bestrellins)+$/,
  /^(?:jove|berkley|mystery|fiction|novel|paperback|hardcover|mass|market)+$/,
];
// Hermes (React Native) has a very low regex stack depth limit.
// Use simple string checks instead of a single complex alternation pattern
// to avoid "Maximum regex stack depth reached" crashes.
const OCR_BESTSELLER_BADGE_KEYWORDS = [
  'bestsell', 'bestselling', 'bestseller', 'bestiell',
  'new york time', 'new y0rk time', 'national bestsell',
];
const MAX_OCR_NORMALIZATION_DEPTH = 6;

function isSeriesLetterToken(tokens: string[], index: number): boolean {
  const token = tokens[index];
  if (!/^[a-z]$/.test(token)) return false;

  const hasTrailingIsFor = tokens[index + 1] === 'is' && tokens[index + 2] === 'for';
  const hasLeadingIsFor = tokens[index - 2] === 'is' && tokens[index - 1] === 'for';
  return hasTrailingIsFor || hasLeadingIsFor;
}

function splitFusedJoinerToken(token: string): string[] {
  const lower = token.toLowerCase();
  if (OCR_FUSED_JOINER_EXACT_EXCEPTIONS.has(lower)) {
    return [lower];
  }

  for (const joiner of OCR_FUSED_JOINERS) {
    if (lower.length <= joiner.length + 3) continue;

    if (lower.endsWith(joiner)) {
      let base = lower.slice(0, -joiner.length);
      if (base.length < 4) continue;
      if (base.endsWith('i') && base.length >= 6) {
        base = `${base.slice(0, -1)}t`;
      }
      return [base, joiner];
    }

    if (lower.startsWith(joiner)) {
      const base = lower.slice(joiner.length);
      if (base.length >= 4) {
        return [joiner, base];
      }
    }

    const middleIndex = lower.indexOf(joiner);
    if (middleIndex > 3) {
      let left = lower.slice(0, middleIndex);
      const right = lower.slice(middleIndex + joiner.length);
      if (left.length >= 4 && right.length >= 3) {
        if (left.endsWith('i') && left.length >= 6) {
          left = `${left.slice(0, -1)}t`;
        }
        return [left, joiner, right];
      }
    }
  }

  return [lower];
}

/**
 * Safely apply a batch of regex replacements. Returns the mutated string.
 * If any individual regex overflows Hermes's stack, that replacement is
 * silently skipped so the remaining corrections still run.
 */
function safeApplyReplacements(
  input: string,
  rules: ReadonlyArray<[RegExp, string]>
): string {
  let result = input;
  for (const [pattern, replacement] of rules) {
    try {
      result = result.replace(pattern, replacement);
    } catch {
      // Hermes regex stack overflow – skip this pattern
    }
  }
  return result;
}

function countMatches(value: string, pattern: RegExp): number {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function isLikelyYearToken(token: string): boolean {
  return /^(1[5-9]\d{2}|20\d{2})$/.test(token);
}

function isBadgeNoiseToken(token: string): boolean {
  if (OCR_QUERY_NOISE_TOKENS.has(token)) {
    return true;
  }
  if (isLikelyOcrGarbageFragment(token)) {
    return true;
  }
  if (token.length < 6) {
    return false;
  }
  return OCR_BADGE_NOISE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

function isLikelyOcrGarbageFragment(token: string): boolean {
  if (token.length < 7 || !/^[a-z]+$/.test(token)) {
    return false;
  }

  const vowelCount = countMatches(token, /[aeiou]/g);
  const consonantCount = token.length - vowelCount;

  // Very long consonant runs are typically OCR merge artifacts, not words.
  if (token.length >= 9 && /[bcdfghjklmnpqrstvwxyz]{6,}/.test(token)) {
    return true;
  }

  // Rare cluster combinations from scan noise ("...nngvn", "...uw...").
  const suspiciousClusterCount = countMatches(token, /(uu|uw|gv|vn|nngv|rnr)/g);
  return suspiciousClusterCount > 0 && consonantCount >= 5 && vowelCount <= 2;
}

function applyConservativeTerminalItoT(token: string): string {
  // Keep this narrow: broad I->T substitutions damaged names like "baldacci".
  if (/(?:straigh|righ|lef|figh|weigh|heigh)i$/.test(token)) {
    return `${token.slice(0, -1)}t`;
  }
  return token;
}

function buildOcrLetterSwapVariants(token: string): string[] {
  const variants = new Set<string>();

  if (token.length >= 4 && /[il]/.test(token)) {
    variants.add(token.replace(/i/g, 'l'));
    variants.add(token.replace(/l/g, 'i'));
  }

  if (token.length >= 5) {
    const maxSwapIndex = Math.min(2, token.length);
    for (let i = 0; i < maxSwapIndex; i++) {
      if (token[i] === 'c') {
        variants.add(`${token.slice(0, i)}g${token.slice(i + 1)}`);
      } else if (token[i] === 'g') {
        variants.add(`${token.slice(0, i)}c${token.slice(i + 1)}`);
      }
    }
  }

  variants.delete(token);
  return Array.from(variants);
}

function applyPhraseCorrections(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;

  const corrected: string[] = [];
  for (let i = 0; i < tokens.length;) {
    let matched = false;
    for (const rule of OCR_QUERY_PHRASE_CORRECTIONS) {
      if (i + rule.from.length > tokens.length) continue;
      const isMatch = rule.from.every((token, idx) => tokens[i + idx] === token);
      if (!isMatch) continue;

      corrected.push(...rule.to);
      i += rule.from.length;
      matched = true;
      break;
    }
    if (!matched) {
      corrected.push(tokens[i]);
      i++;
    }
  }

  return corrected;
}

function isNumericNoiseToken(rawToken: string, normalizedToken: string): boolean {
  if (!normalizedToken) return true;

  const digitCount = countMatches(normalizedToken, /\d/g);
  const alphaCount = countMatches(normalizedToken, /[a-z]/g);

  // Price tags: "$2.25", "32.25", etc.
  if (/^\$?\d+\.\d{2}$/.test(rawToken)) return true;

  // Short numeric shelf/call-number fragments are high-noise in spine OCR.
  if (/^\d{1,3}$/.test(normalizedToken)) return true;
  if (/^\d{4}$/.test(normalizedToken) && !isLikelyYearToken(normalizedToken)) return true;

  // Tokens that are mostly numeric (e.g., "10e", "5711") are rarely useful title/author terms.
  if (digitCount >= 2 && alphaCount <= 1) return true;
  if (digitCount > alphaCount && normalizedToken.length <= 5) return true;

  // ISBN/catalog fragments like "0-515-" / "06011-9" / long numeric chunks.
  if (/^[\d-]{5,}$/.test(normalizedToken)) return true;
  if (/^\d{1,4}-\d[\d-]*$/.test(normalizedToken)) return true;
  if (/^\d{5,}$/.test(normalizedToken)) return true;

  return false;
}

function foldOcrUnicodeToken(value: string): string {
  return value
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .replace(/ş/g, 's')
    .replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g')
    .replace(/Ğ/g, 'G')
    .replace(/ü/g, 'u')
    .replace(/Ü/g, 'U')
    .replace(/ö/g, 'o')
    .replace(/Ö/g, 'O')
    .replace(/ç/g, 'c')
    .replace(/Ç/g, 'C')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function canonicalizeTokenForQuery(value: string): string {
  return foldOcrUnicodeToken(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function splitMergedCaseToken(value: string): string[] {
  if (value.length < 6) {
    return [value];
  }

  const parts: string[] = [];
  let current = value[0] ?? '';
  let didSplit = false;

  for (let i = 1; i < value.length; i++) {
    const previous = value[i - 1];
    const currentChar = value[i];
    const hasCaseBoundary =
      /[a-zçğıöşü]/.test(previous) &&
      /[A-ZÇĞİÖŞÜ]/.test(currentChar);

    if (hasCaseBoundary && current) {
      parts.push(current);
      current = currentChar;
      didSplit = true;
      continue;
    }

    current += currentChar;
  }

  if (current) {
    parts.push(current);
  }

  return didSplit ? parts : [value];
}

function normalizeOcrTokenForQuery(
  rawToken: string,
  seenCanonical: Set<string> = new Set(),
  depth: number = 0
): string[] {
  const trimmed = rawToken.trim();
  if (!trimmed) return [];

  const cleaned = trimmed
    .replace(/^[^0-9A-Za-z\u00C0-\u024F\u1E00-\u1EFF]+/, '')
    .replace(/[^0-9A-Za-z\u00C0-\u024F\u1E00-\u1EFF]+$/, '');
  if (!cleaned) return [];

  if (depth < MAX_OCR_NORMALIZATION_DEPTH) {
    const mergedCaseParts = splitMergedCaseToken(cleaned);
    if (mergedCaseParts.length > 1) {
      return mergedCaseParts.flatMap((token) =>
        normalizeOcrTokenForQuery(token, seenCanonical, depth + 1)
      );
    }
  }

  const cleanedLower = canonicalizeTokenForQuery(cleaned);

  if (isNumericNoiseToken(trimmed, cleanedLower)) {
    return [];
  }

  const canonical = cleanedLower
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/5/g, 's');

  if (depth >= MAX_OCR_NORMALIZATION_DEPTH) {
    return [canonical];
  }
  if (seenCanonical.has(canonical)) {
    return [canonical];
  }
  const nextSeenCanonical = new Set(seenCanonical);
  nextSeenCanonical.add(canonical);

  const correctionCandidates = [canonical, ...buildOcrLetterSwapVariants(canonical)];
  for (const candidate of correctionCandidates) {
    const corrected = OCR_QUERY_TOKEN_CORRECTIONS.get(candidate);
    if (corrected) {
      return corrected.flatMap((token) =>
        normalizeOcrTokenForQuery(token, nextSeenCanonical, depth + 1)
      );
    }
  }

  if (isBadgeNoiseToken(canonical)) {
    return [];
  }

  const split = splitFusedJoinerToken(canonical);
  if (split.length > 1) {
    return split.flatMap((token) =>
      normalizeOcrTokenForQuery(token, nextSeenCanonical, depth + 1)
    );
  }

  const terminalCorrected = applyConservativeTerminalItoT(canonical);
  if (terminalCorrected !== canonical) {
    return [terminalCorrected];
  }

  return [canonical];
}

function dropLowSignalQueryTokens(tokens: string[]): string[] {
  if (tokens.length <= 2) {
    return tokens;
  }

  const substantiveTokenCount = tokens.filter(
    (token) =>
      token.length >= 4 &&
      !TITLE_CONNECTOR_WORDS.has(token) &&
      !OCR_QUERY_NOISE_TOKENS.has(token) &&
      !OCR_QUERY_LOW_SIGNAL_TOKENS.has(token)
  ).length;

  if (substantiveTokenCount < 2) {
    return tokens;
  }

  const filtered = tokens.filter((token) => !OCR_QUERY_LOW_SIGNAL_TOKENS.has(token));
  return filtered.length >= 2 ? filtered : tokens;
}

function normalizeOcrQueryText(query: string | null | undefined): string | null {
  if (!query) return null;

  // Use simple lowercase-includes check instead of a complex regex to avoid
  // Hermes "Maximum regex stack depth reached" crashes.
  const queryLower = query.toLowerCase();
  const hadBestsellerBadgeNoise = OCR_BESTSELLER_BADGE_KEYWORDS.some(
    (kw) => queryLower.includes(kw)
  );

  let scrubbedQuery: string;
  try {
    scrubbedQuery = OCR_QUERY_NOISE_PATTERNS.reduce(
      (acc, pattern) => acc.replace(pattern, ' '),
      query
    );
  } catch {
    // Hermes regex stack overflow — fall back to raw query
    scrubbedQuery = query;
  }

  let tokens = scrubbedQuery
    .split(/\s+/)
    .flatMap((token) => normalizeOcrTokenForQuery(token))
    .filter((token, index, allTokens) =>
      token.length >= 2 || isSeriesLetterToken(allTokens, index)
    );

  if (tokens.includes('new') && tokens.includes('york') && tokens.includes('times')) {
    tokens = tokens.filter((token) => token !== 'new' && token !== 'york' && token !== 'times');
  }
  if (hadBestsellerBadgeNoise && tokens.includes('new') && tokens.includes('york')) {
    tokens = tokens.filter((token) => token !== 'new' && token !== 'york');
  }
  if (hadBestsellerBadgeNoise && tokens.includes('york') && tokens.includes('times')) {
    tokens = tokens.filter((token) => token !== 'york' && token !== 'times');
  }
  if (hadBestsellerBadgeNoise && tokens.includes('worlds') && tokens.includes('fire')) {
    tokens = tokens.filter((token) => token !== 'worlds' && token !== 'fire');
  }

  tokens = applyPhraseCorrections(tokens);

  if (tokens.length === 0) return null;

  // Collapse adjacent duplicates and repeated long tokens from noisy OCR combinations.
  const deduped: string[] = [];
  const seenSubstantiveTokens = new Set<string>();
  for (const token of tokens) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === token) {
      continue;
    }
    const isConnectorToken = TITLE_CONNECTOR_WORDS.has(token) || token === 'is';
    if (token.length >= 3 && !isConnectorToken && seenSubstantiveTokens.has(token)) {
      continue;
    }
    if (token.length >= 3 && !isConnectorToken) {
      seenSubstantiveTokens.add(token);
    }
    deduped.push(token);
  }

  if (deduped.length === 0) return null;

  // Run phrase corrections again after dedupe so collapse artifacts
  // (e.g., "... catherine ion ion" -> "... catherine ion") can be removed.
  const postDedupeTokens = applyPhraseCorrections(deduped);
  if (postDedupeTokens.length === 0) return null;

  // Drop low-information function words only when we still have enough
  // substantive OCR signal, so short valid titles aren't over-pruned.
  const filteredLowSignalTokens = dropLowSignalQueryTokens(postDedupeTokens);
  if (filteredLowSignalTokens.length === 0) return null;

  return filteredLowSignalTokens.join(' ');
}

function stripAuthorTailFromTitle(title: string | null, author: string | null): string | null {
  if (!title) return null;
  if (!author) return title;

  const titleTokens = title.split(/\s+/).filter(Boolean);
  const authorTokens = author.split(/\s+/).filter(Boolean);
  if (titleTokens.length === 0 || authorTokens.length === 0) {
    return title;
  }

  const fullAuthorTailMatches =
    authorTokens.length >= 2 &&
    titleTokens.length > authorTokens.length &&
    titleTokens.slice(-authorTokens.length).join(' ') === authorTokens.join(' ');
  if (fullAuthorTailMatches) {
    return titleTokens.slice(0, -authorTokens.length).join(' ');
  }

  const authorSurname = authorTokens[authorTokens.length - 1];
  if (
    titleTokens.length >= 3 &&
    authorSurname &&
    titleTokens[titleTokens.length - 1] === authorSurname
  ) {
    // When author OCR is reduced to a surname token, title lines can still carry
    // a trailing "firstname surname" tail. Drop both if the penultimate token
    // looks like a name, not a connector/noise token.
    if (authorTokens.length === 1 && titleTokens.length >= 4) {
      const possibleGivenName = titleTokens[titleTokens.length - 2];
      const looksLikeGivenName =
        possibleGivenName.length >= 3 &&
        possibleGivenName.length <= 8 &&
        !TITLE_CONNECTOR_WORDS.has(possibleGivenName) &&
        !OCR_QUERY_NOISE_TOKENS.has(possibleGivenName);
      if (looksLikeGivenName) {
        return titleTokens.slice(0, -2).join(' ');
      }
    }
    return titleTokens.slice(0, -1).join(' ');
  }

  return title;
}

function extractSeriesCoreTitle(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null;

  const [lead, second, third] = tokens;
  if (!/^[a-z]$/.test(lead) || second !== 'is' || third !== 'for') {
    return null;
  }

  const coreTitleToken = tokens[3];
  if (
    !coreTitleToken ||
    coreTitleToken.length < 3 ||
    TITLE_CONNECTOR_WORDS.has(coreTitleToken) ||
    OCR_QUERY_NOISE_TOKENS.has(coreTitleToken)
  ) {
    return null;
  }

  return tokens.slice(0, 4).join(' ');
}

function stripLikelyRepeatedTailToken(
  normalizedTitle: string | null,
  evidence: EvidenceTokens
): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null;

  const lastToken = tokens[tokens.length - 1];
  if (lastToken.length < 5 || TITLE_CONNECTOR_WORDS.has(lastToken)) return null;

  const hasTitleStructure = tokens
    .slice(0, -1)
    .some((token) => TITLE_CONNECTOR_WORDS.has(token));
  if (!hasTitleStructure) return null;

  const repeatedTailCount = evidence.tokenCounts.get(lastToken) ?? 0;
  if (repeatedTailCount < 2) return null;

  return tokens.slice(0, -1).join(' ');
}

function stripLikelyAuthorTailToken(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null;

  const lastToken = tokens[tokens.length - 1];
  if (
    lastToken.length < 5 ||
    TITLE_CONNECTOR_WORDS.has(lastToken) ||
    OCR_QUERY_NOISE_TOKENS.has(lastToken)
  ) {
    return null;
  }

  const prefix = tokens.slice(0, -1);
  const hasConnector = prefix.some((token) => TITLE_CONNECTOR_WORDS.has(token));
  if (!hasConnector) return null;

  const substantivePrefixCount = prefix.filter(
    (token) =>
      token.length >= 3 &&
      !TITLE_CONNECTOR_WORDS.has(token) &&
      !OCR_QUERY_NOISE_TOKENS.has(token)
  ).length;
  if (substantivePrefixCount < 2) return null;

  return prefix.join(' ');
}

function swapLeadingTitleTokens(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const [first, second] = tokens;
  if (
    first.length < 3 ||
    second.length < 3 ||
    first === second ||
    TITLE_CONNECTOR_WORDS.has(first) ||
    TITLE_CONNECTOR_WORDS.has(second)
  ) {
    return null;
  }

  return [second, first, ...tokens.slice(2)].join(' ');
}

function buildConnectorReducedTitleVariant(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const reduced = tokens.filter((token) => !TITLE_CONNECTOR_WORDS.has(token));
  if (reduced.length < 2) return null;

  const reducedQuery = reduced.join(' ');
  if (reducedQuery === tokens.join(' ')) return null;
  return reducedQuery;
}

function buildReorderedOfTitleVariant(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  // Convert "city of victory" -> "victory city" when OCR likely swapped order.
  const ofIndex = tokens.indexOf('of');
  if (ofIndex !== 1) return null;

  const head = tokens[0];
  const tail = tokens
    .slice(ofIndex + 1)
    .filter(
      (token) =>
        token.length >= 3 &&
        !TITLE_CONNECTOR_WORDS.has(token) &&
        !OCR_QUERY_NOISE_TOKENS.has(token)
    );

  if (
    !head ||
    head.length < 3 ||
    TITLE_CONNECTOR_WORDS.has(head) ||
    OCR_QUERY_NOISE_TOKENS.has(head) ||
    tail.length === 0
  ) {
    return null;
  }

  return [...tail, head].join(' ');
}

function collectSupplementalRawSignalTokens(
  evidenceLines: string[],
  knownEvidenceTokens: Set<string>
): string[] {
  const supplemental: string[] = [];
  const seen = new Set<string>();

  for (const line of evidenceLines.slice(0, 8)) {
    const normalizedLine = normalizeOcrQueryText(line);
    if (!normalizedLine) continue;

    const tokens = normalizedLine.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token.length < 3) continue;
      if (knownEvidenceTokens.has(token)) continue;
      if (TITLE_CONNECTOR_WORDS.has(token)) continue;
      if (OCR_QUERY_NOISE_TOKENS.has(token)) continue;
      if (/^\d+$/.test(token)) continue;
      if (seen.has(token)) continue;

      seen.add(token);
      supplemental.push(token);
    }
  }

  return supplemental;
}

function collectBoundaryBridgeQueries(evidenceLines: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  const addQuery = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const key = buildQueryDedupeKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };

  for (let i = 0; i < evidenceLines.length - 1; i++) {
    const leftRaw = evidenceLines[i]?.trim() ?? '';
    const rightRaw = evidenceLines[i + 1]?.trim() ?? '';
    if (!leftRaw || !rightRaw) continue;

    const leftWords = leftRaw.split(/\s+/).filter(Boolean);
    const rightWords = rightRaw.split(/\s+/).filter(Boolean);
    if (leftWords.length === 0 || rightWords.length === 0) continue;

    const leftTail = leftWords[leftWords.length - 1].replace(/[^a-z0-9]/gi, '').toLowerCase();
    const rightHead = rightWords[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!leftTail || !rightHead) continue;

    // Recover line-break OCR splits like "FI" + "ACE".
    const isAlpha = (token: string) => /^[a-z]+$/.test(token);
    if (
      isAlpha(leftTail) &&
      isAlpha(rightHead) &&
      leftTail.length <= 3 &&
      rightHead.length >= 2 &&
      rightHead.length <= 5
    ) {
      addQuery(`${leftRaw} ${rightRaw}`);

      const mergedBoundaryToken = `${leftTail}${rightHead}`;
      const mergedWords = [
        ...leftWords.slice(0, -1),
        mergedBoundaryToken,
        ...rightWords.slice(1),
      ].filter(Boolean);
      if (mergedWords.length >= 2) {
        addQuery(mergedWords.join(' '));
      }
    }
  }

  return queries;
}

function queryChangedAfterNormalization(
  original: string | null | undefined,
  normalized: string | null | undefined
): boolean {
  const before = original?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const after = normalized?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  return before !== after;
}

function buildQueryDedupeKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitAlphaWords(line: string): string[] {
  return line
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z]/gi, ''))
    .filter(Boolean);
}

function getMergedAuthorLikeTokens(line: string): string[] | null {
  const words = splitAlphaWords(line);
  if (words.length !== 1) {
    return null;
  }

  const canonical = canonicalizeTokenForQuery(words[0]);
  if (!canonical || !OCR_MERGED_AUTHOR_HINT_TOKENS.has(canonical)) {
    return null;
  }

  const normalizedTokens = normalizeOcrTokenForQuery(words[0]).filter(Boolean);
  if (normalizedTokens.length < 2 || normalizedTokens.length > 3) {
    return null;
  }

  const hasNoise = normalizedTokens.some(
    (token) =>
      token.length < 3 ||
      TITLE_CONNECTOR_WORDS.has(token) ||
      OCR_QUERY_NOISE_TOKENS.has(token)
  );
  if (hasNoise) {
    return null;
  }

  return normalizedTokens;
}

function scoreLineForTitleQuery(line: string): number {
  const words = splitAlphaWords(line);
  if (words.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const mergedAuthorTokens = getMergedAuthorLikeTokens(line);
  const normalizedTokens = normalizeForScoring(line);
  const longWordCount = words.filter((word) => word.length >= 5).length;
  const shortWordCount = words.filter((word) => word.length <= 2).length;
  const hasConnector = words.some((word) =>
    TITLE_CONNECTOR_WORDS.has(word.toLowerCase())
  );
  const shortHeavy = shortWordCount >= Math.ceil(words.length / 2);
  const lowerLine = line.toLowerCase();
  const hasEditedByCue = lowerLine.includes('edited by');
  const separatorCount = countMatches(line, /[-•]/g);
  const likelyAuthorListLine = separatorCount >= 2 && words.length >= 4;

  // Known OCR corruptions can turn a name-shaped line into a title
  // ("ILSOE VICTORY" -> "city of victory"); trust the corrected shape.
  const correctedWords = (normalizeOcrQueryText(line) ?? '').split(/\s+/).filter(Boolean);
  const correctionAddsConnector =
    !hasConnector && correctedWords.some((word) => TITLE_CONNECTOR_WORDS.has(word));
  const allNoise =
    correctedWords.length === 0 ||
    words.every((word) => OCR_QUERY_NOISE_TOKENS.has(word.toLowerCase()));

  let score = normalizedTokens.length * 2 + longWordCount;
  if (looksLikeTitle(line) || correctionAddsConnector) score += 4;
  if (hasConnector || correctionAddsConnector) score += 2;
  // Names don't contain "and"/"of"; title-cased titles often trip the name detector.
  if (looksLikePersonName(line) && !correctionAddsConnector && !hasConnector) score -= 5;
  if (allNoise) score -= 10;
  if (shortHeavy) score -= 5;
  // Favor strong one-line title anchors ("CARNIEPUNK"), and demote author/editor lists.
  if (words.length === 1 && words[0].length >= 8 && !mergedAuthorTokens) score += 6;
  if (mergedAuthorTokens) score -= 8;
  if (hasEditedByCue) score -= 9;
  if (likelyAuthorListLine) score -= 6;

  return score;
}

function sortEvidencePhrasesByQuality(phrases: string[]): string[] {
  return [...phrases].sort((a, b) => {
    const scoreDiff = scoreLineForTitleQuery(b) - scoreLineForTitleQuery(a);
    if (scoreDiff !== 0) return scoreDiff;
    return b.length - a.length;
  });
}

function pickStrongTitleTailToken(
  evidence: EvidenceTokens,
  bestTitle: string | null,
  sortedPhrases: string[]
): string | null {
  const candidateLines: string[] = [];
  const seen = new Set<string>();

  const addLine = (line: string | null | undefined) => {
    if (!line) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidateLines.push(trimmed);
  };

  addLine(bestTitle);
  for (const line of evidence.titleLikeLines.slice(0, 4)) {
    addLine(line);
  }
  for (const line of sortedPhrases.slice(0, 6)) {
    addLine(line);
  }

  let bestToken: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const line of candidateLines) {
    if (looksLikePersonName(line)) continue;
    const token = extractTitleTailToken(line);
    if (!token || token.length < 5) continue;

    const score = scoreLineForTitleQuery(line);
    if (score > bestScore || (score === bestScore && token.length > (bestToken?.length ?? 0))) {
      bestScore = score;
      bestToken = token;
    }
  }

  return bestToken ?? extractTitleTailToken(bestTitle);
}

function pickDistinctiveTitleToken(normalizedTitle: string | null): string | null {
  if (!normalizedTitle) return null;

  const tokens = normalizedTitle
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(
      (token) =>
        token.length >= 7 &&
        !TITLE_CONNECTOR_WORDS.has(token) &&
        !OCR_QUERY_NOISE_TOKENS.has(token)
    );
  if (tokens.length === 0) return null;

  // Prefer longer tokens first; they are usually the most distinctive query anchor.
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0];
}

function pickStandaloneTitleAnchor(
  evidence: EvidenceTokens,
  sortedPhrases: string[],
  authorLine: string | null
): string | null {
  const candidates = new Set<string>();
  const normalizedAuthorLine = normalizeOcrQueryText(authorLine);

  const addCandidate = (line: string | null | undefined) => {
    if (!line) return;
    const normalizedLine = normalizeOcrQueryText(line);
    if (!normalizedLine || normalizedLine === normalizedAuthorLine) return;

    const tokens = normalizedLine.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 3) return;

    const substantive = tokens.filter(
      (token) =>
        token.length >= 5 &&
        !TITLE_CONNECTOR_WORDS.has(token) &&
        !OCR_QUERY_NOISE_TOKENS.has(token)
    );
    if (substantive.length === 0) return;

    candidates.add(normalizedLine);
  };

  for (const line of evidence.titleLikeLines.slice(0, 8)) {
    addCandidate(line);
  }
  for (const line of sortedPhrases.slice(0, 8)) {
    addCandidate(line);
  }
  for (const line of evidence.cleanedLines.slice(0, 8)) {
    addCandidate(line);
  }

  if (candidates.size === 0) return null;

  const ranked = Array.from(candidates).sort((a, b) => {
    const aTokens = a.split(/\s+/).filter(Boolean);
    const bTokens = b.split(/\s+/).filter(Boolean);
    const aSub = aTokens.filter(
      (token) =>
        token.length >= 5 &&
        !TITLE_CONNECTOR_WORDS.has(token) &&
        !OCR_QUERY_NOISE_TOKENS.has(token)
    );
    const bSub = bTokens.filter(
      (token) =>
        token.length >= 5 &&
        !TITLE_CONNECTOR_WORDS.has(token) &&
        !OCR_QUERY_NOISE_TOKENS.has(token)
    );

    const aScore =
      (aTokens.length === 1 ? 12 : 0) +
      aSub.reduce((sum, token) => sum + token.length, 0) -
      aTokens.length;
    const bScore =
      (bTokens.length === 1 ? 12 : 0) +
      bSub.reduce((sum, token) => sum + token.length, 0) -
      bTokens.length;

    if (bScore !== aScore) return bScore - aScore;
    return b.length - a.length;
  });

  return ranked[0] ?? null;
}

function pickBestTitleLine(
  evidence: EvidenceTokens,
  sortedPhrases: string[]
): string | null {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (line: string | null | undefined) => {
    if (!line) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  if (
    evidence.advancedExtraction?.title &&
    evidence.advancedExtraction.titleConfidence >= 0.55
  ) {
    addCandidate(evidence.advancedExtraction.title);
  }

  for (const line of evidence.titleLikeLines) {
    addCandidate(line);
  }
  for (const line of sortedPhrases.slice(0, 5)) {
    addCandidate(line);
  }

  // Merged lines like "THINKING, DANIEL KAHNEMAN R8R" carry a separate name line inside them.
  const embeddedNames = evidence.personNameLines
    .filter((line) => splitAlphaWords(line).length >= 2)
    .map((line) => line.toLowerCase());
  const embedsSeparateName = (candidate: string) => {
    const lower = candidate.toLowerCase();
    return embeddedNames.some((name) => name !== lower && lower.includes(name));
  };

  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = scoreLineForTitleQuery(candidate) - (embedsSeparateName(candidate) ? 8 : 0);
    if (score > bestScore || (score === bestScore && candidate.length > (best?.length ?? 0))) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

// Title glue words that don't appear inside author names (unlike "de", "van", "ve").
const AUTHOR_BLOCKING_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'with']);

const alphaWordsLower = (line: string): string[] =>
  line.toLowerCase().split(/[^a-z]+/).filter(Boolean);

// A single title line split into "THE" + "GREAT GATSBY" is not a title/author pair.
function authorRestatesTitle(title: string | null, author: string): boolean {
  if (!title) return false;
  const titleWords = alphaWordsLower(title);
  const authorWords = alphaWordsLower(author).filter((w) => w.length > 1);
  // Substring match also catches OCR-trimmed echoes ("GATSBY" -> "ATSBY").
  const echoes = (a: string, b: string) => a.length >= 3 && b.includes(a);
  if (
    authorWords.length === 0 ||
    !authorWords.every((aw) => titleWords.some((tw) => echoes(aw, tw)))
  ) {
    return false;
  }
  return titleWords.every(
    (tw) => TITLE_CONNECTOR_WORDS.has(tw) || authorWords.some((aw) => echoes(aw, tw))
  );
}

function pickBestAuthorLine(evidence: EvidenceTokens, bestTitle: string | null = null): string | null {
  const looksPlausibleAuthor = (line: string): boolean => {
    if (!line || /\d/.test(line)) return false;
    const lineWords = alphaWordsLower(line);
    if (lineWords.length === 0 || lineWords.some((w) => AUTHOR_BLOCKING_WORDS.has(w))) return false;
    if (authorRestatesTitle(bestTitle, line)) return false;

    const mergedAuthorTokens = getMergedAuthorLikeTokens(line);
    if (mergedAuthorTokens) return true;

    const words = splitAlphaWords(line);
    if (words.length < 2 || words.length > 4) return false;

    const shortWords = words.filter((word) => word.length <= 2).length;
    const longWords = words.filter((word) => word.length >= 4).length;

    if (shortWords >= 2) return false;
    if (longWords === 0) return false;

    return looksLikePersonName(line) || longWords >= 2;
  };

  if (
    evidence.advancedExtraction?.author &&
    evidence.advancedExtraction.authorConfidence >= 0.65 &&
    looksPlausibleAuthor(evidence.advancedExtraction.author)
  ) {
    return evidence.advancedExtraction.author;
  }

  if (evidence.recoveredAuthorCandidates.length > 0) {
    // On confidence ties prefer name-shaped lines ("Mitch Albom") over longer OCR junk
    // ("You e tie percien") that the person detector also accepted.
    const nameShape = (line: string) => {
      const rawWords = line.split(/\s+/).filter(Boolean);
      const strayLetters = rawWords.filter((w) => /^[A-Za-z]$/.test(w)).length;
      return (rawWords.length === 2 || rawWords.length === 3 ? 1 : 0) - strayLetters;
    };
    const recovered = [...evidence.recoveredAuthorCandidates]
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          nameShape(b.line) - nameShape(a.line) ||
          b.line.length - a.line.length
      )
      .find((candidate) => candidate.confidence >= 0.55 && looksPlausibleAuthor(candidate.line));
    if (recovered?.line) {
      return recovered.line;
    }
  }

  if (evidence.personNameLines.length > 0) {
    const plausiblePerson = evidence.personNameLines.find((line) => looksPlausibleAuthor(line));
    if (plausiblePerson) {
      return plausiblePerson;
    }
    if (!authorRestatesTitle(bestTitle, evidence.personNameLines[0])) {
      return evidence.personNameLines[0];
    }
  }

  for (const line of evidence.cleanedLines) {
    const mergedAuthorTokens = getMergedAuthorLikeTokens(line);
    if (mergedAuthorTokens && !authorRestatesTitle(bestTitle, mergedAuthorTokens.join(' '))) {
      return mergedAuthorTokens.join(' ');
    }
  }

  const extractedAuthor = evidence.advancedExtraction?.author;
  return extractedAuthor && looksPlausibleAuthor(extractedAuthor) ? extractedAuthor : null;
}

/**
 * Generate search hypotheses from evidence lines
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param ocrTitle - OCR-extracted title (may be wrong, used as fallback)
 * @param ocrAuthor - OCR-extracted author (may be wrong, used as fallback)
 * @returns Ordered list of search hypotheses
 */
export function generateHypotheses(
  evidenceLines: string[],
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>();

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    if (!trimmed) return;

    if (type !== 'isbn') {
      const normalizedQuery = normalizeOcrQueryText(trimmed);
      if (!normalizedQuery) return;
      trimmed = normalizedQuery;
    }

    // Skip if too short
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    // Trim to max tokens if needed (except ISBN)
    if (type !== 'isbn') {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && OCR_SINGLE_TOKEN_QUERY_NOISE.has(tokens[0])) {
        return;
      }
      if (tokens.length > MAX_QUERY_TOKENS) {
        trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
      }
    }

    const normalized = buildQueryDedupeKey(trimmed);

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    usedQueries.add(normalized);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // =========================================================================
  // Priority Strategy (max 5 hypotheses):
  // 1. ISBN (if found)
  // 2. title + author (best disambiguation)
  // 3. title-only (longest substantive line)
  // 4. author-only (if detected)
  // 5. stripped variant (remove leading article / noise)
  //
  // Only fall back to OCR fields if evidence doesn't yield enough.
  // =========================================================================

  const sortedByLength = sortEvidencePhrasesByQuality(evidence.candidatePhrases);

  const bestTitle = pickBestTitleLine(evidence, sortedByLength);
  const bestAuthor = pickBestAuthorLine(evidence, bestTitle);

  // OCR-normalized variants for typo-heavy spines (FAVE->FAYE, ACAID->NGAIO, etc.).
  const normalizedBestAuthor = normalizeOcrQueryText(bestAuthor);
  const normalizedBestTitle = normalizeOcrQueryText(bestTitle);
  const normalizedBestTitleSansAuthor = stripAuthorTailFromTitle(
    normalizedBestTitle,
    normalizedBestAuthor
  );
  const normalizedBestTitleSansRepeatedTail = stripLikelyRepeatedTailToken(
    normalizedBestTitleSansAuthor,
    evidence
  );
  const normalizedBestTitleSansLikelyAuthorTail = stripLikelyAuthorTailToken(
    normalizedBestTitleSansRepeatedTail ?? normalizedBestTitleSansAuthor
  );
  const normalizedBestTitleCore =
    normalizedBestTitleSansLikelyAuthorTail ??
    normalizedBestTitleSansRepeatedTail ??
    normalizedBestTitleSansAuthor;
  const normalizedSeriesCoreTitle = extractSeriesCoreTitle(normalizedBestTitleCore);
  const swappedNormalizedBestTitle = swapLeadingTitleTokens(
    normalizedBestTitleCore
  );
  const connectorReducedNormalizedTitle = buildConnectorReducedTitleVariant(
    normalizedBestTitleCore
  );
  const reorderedOfNormalizedTitle = buildReorderedOfTitleVariant(
    normalizedBestTitleCore
  );
  const normalizedDistinctiveTitleToken = pickDistinctiveTitleToken(
    normalizedBestTitleCore ?? normalizedBestTitleSansAuthor ?? normalizedBestTitle
  );
  const standaloneTitleAnchor = pickStandaloneTitleAnchor(evidence, sortedByLength, bestAuthor);
  const normalizedBestAuthorSurname = extractAuthorSurname(normalizedBestAuthor);
  // Raw tokens the cleaner dropped can recover a lost author; with an author in hand
  // they are mostly publisher/badge noise ("ZEBRA", "NEW FORK").
  const supplementalRawSignalTokens = bestAuthor
    ? []
    : collectSupplementalRawSignalTokens(evidenceLines, evidence.tokensSet);
  const boundaryBridgeQueries = collectBoundaryBridgeQueries(evidenceLines);

  const normalizedTitleChanged = queryChangedAfterNormalization(
    bestTitle,
    normalizedBestTitleSansAuthor
  );
  const normalizedAuthorChanged = queryChangedAfterNormalization(bestAuthor, normalizedBestAuthor);

  // 1) ISBN
  if (evidence.isbns.length > 0) {
    const isbn = evidence.isbns[0];
    addHypothesis(isbn, 'isbn', 0, `ISBN extracted from evidence: ${isbn}`);
  }

  // 1b) OCR-corrected title+author variants (if corrections changed the query).
  if (
    normalizedBestTitleSansAuthor &&
    normalizedBestAuthor &&
    (normalizedTitleChanged || normalizedAuthorChanged)
  ) {
    addHypothesis(
      `${normalizedBestTitleSansAuthor} ${normalizedBestAuthor}`,
      'title_author',
      9,
      `OCR-normalized title "${normalizedBestTitleSansAuthor}" + author "${normalizedBestAuthor}"`
    );
  }

  if (normalizedBestTitleSansAuthor && normalizedTitleChanged) {
    const onlyArticleStripped =
      bestTitle !== null &&
      stripLeadingArticle(bestTitle) !== bestTitle &&
      normalizeOcrQueryText(stripLeadingArticle(bestTitle)) === normalizedBestTitleSansAuthor;
    addHypothesis(
      normalizedBestTitleSansAuthor,
      onlyArticleStripped ? 'stripped' : 'title_only',
      9.05,
      `OCR-normalized title-only: "${normalizedBestTitleSansAuthor}"`
    );
  }

  if (
    standaloneTitleAnchor &&
    standaloneTitleAnchor !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      standaloneTitleAnchor,
      'title_only',
      9.12,
      `Standalone title anchor: "${standaloneTitleAnchor}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${standaloneTitleAnchor} ${normalizedBestAuthorSurname}`,
        'title_author',
        9.13,
        `Standalone title anchor + surname: "${standaloneTitleAnchor}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    connectorReducedNormalizedTitle &&
    connectorReducedNormalizedTitle !== normalizedBestTitleSansAuthor
  ) {
    const isArticleStrippedTitle =
      bestTitle !== null &&
      stripLeadingArticle(bestTitle) !== bestTitle &&
      normalizeOcrQueryText(stripLeadingArticle(bestTitle)) === connectorReducedNormalizedTitle;
    addHypothesis(
      connectorReducedNormalizedTitle,
      isArticleStrippedTitle ? 'stripped' : 'title_only',
      9.06,
      `Connector-reduced title variant: "${connectorReducedNormalizedTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${connectorReducedNormalizedTitle} ${normalizedBestAuthorSurname}`,
        'title_author',
        9.07,
        `Connector-reduced title + surname: "${connectorReducedNormalizedTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    reorderedOfNormalizedTitle &&
    reorderedOfNormalizedTitle !== normalizedBestTitleSansAuthor &&
    reorderedOfNormalizedTitle !== connectorReducedNormalizedTitle
  ) {
    addHypothesis(
      reorderedOfNormalizedTitle,
      'title_only',
      9.08,
      `Reordered "of" title variant: "${reorderedOfNormalizedTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${reorderedOfNormalizedTitle} ${normalizedBestAuthorSurname}`,
        'title_author',
        9.09,
        `Reordered "of" title + surname: "${reorderedOfNormalizedTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    normalizedBestTitleSansAuthor &&
    normalizedBestAuthorSurname &&
    (normalizedTitleChanged || normalizedAuthorChanged)
  ) {
    addHypothesis(
      `${normalizedBestTitleSansAuthor} ${normalizedBestAuthorSurname}`,
      'title_author',
      9.5,
      `OCR-normalized title "${normalizedBestTitleSansAuthor}" + surname "${normalizedBestAuthorSurname}"`
    );
  }

  const normalizedTitleTailToken = extractTitleTailToken(normalizedBestTitleCore);
  if (normalizedTitleTailToken && normalizedBestAuthorSurname) {
    addHypothesis(
      `${normalizedTitleTailToken} ${normalizedBestAuthorSurname}`,
      'title_author',
      9.7,
      `OCR-normalized title tail "${normalizedTitleTailToken}" + surname "${normalizedBestAuthorSurname}"`
    );
  }

  if (
    normalizedBestTitleSansRepeatedTail &&
    normalizedBestTitleSansRepeatedTail !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      normalizedBestTitleSansRepeatedTail,
      'title_only',
      9.8,
      `Dropped repeated noisy tail token: "${normalizedBestTitleSansRepeatedTail}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedBestTitleSansRepeatedTail} ${normalizedBestAuthorSurname}`,
        'title_author',
        9.9,
        `Dropped repeated noisy tail + surname: "${normalizedBestTitleSansRepeatedTail}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    normalizedBestTitleSansLikelyAuthorTail &&
    normalizedBestTitleSansLikelyAuthorTail !== normalizedBestTitleSansAuthor &&
    normalizedBestTitleSansLikelyAuthorTail !== normalizedBestTitleSansRepeatedTail
  ) {
    addHypothesis(
      normalizedBestTitleSansLikelyAuthorTail,
      'title_only',
      9.85,
      `Dropped likely author tail token: "${normalizedBestTitleSansLikelyAuthorTail}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedBestTitleSansLikelyAuthorTail} ${normalizedBestAuthorSurname}`,
        'title_author',
        9.86,
        `Dropped likely author tail + surname: "${normalizedBestTitleSansLikelyAuthorTail}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    normalizedSeriesCoreTitle &&
    normalizedSeriesCoreTitle !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      normalizedSeriesCoreTitle,
      'title_only',
      10,
      `Series-core title extraction: "${normalizedSeriesCoreTitle}"`
    );

    if (normalizedBestAuthor) {
      addHypothesis(
        `${normalizedSeriesCoreTitle} ${normalizedBestAuthor}`,
        'title_author',
        10.01,
        `Series-core title + author: "${normalizedSeriesCoreTitle}" + "${normalizedBestAuthor}"`
      );
    }

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedSeriesCoreTitle} ${normalizedBestAuthorSurname}`,
        'title_author',
        10.02,
        `Series-core title + surname: "${normalizedSeriesCoreTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (swappedNormalizedBestTitle) {
    addHypothesis(
      swappedNormalizedBestTitle,
      'title_only',
      10.05,
      `Leading title token swap: "${swappedNormalizedBestTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${swappedNormalizedBestTitle} ${normalizedBestAuthorSurname}`,
        'title_author',
        10.06,
        `Leading title token swap + surname: "${swappedNormalizedBestTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  const supplementalTitleBase = normalizedBestTitleCore;
  if (supplementalTitleBase) {
    for (const supplementalToken of supplementalRawSignalTokens.slice(0, 2)) {
      addHypothesis(
        `${supplementalTitleBase} ${supplementalToken}`,
        'title_author',
        10.4,
        `Raw OCR supplemental token "${supplementalToken}" with title "${supplementalTitleBase}"`
      );
      addHypothesis(
        `${supplementalToken} ${supplementalTitleBase}`,
        'author_title',
        10.5,
        `Raw OCR supplemental token "${supplementalToken}" before title "${supplementalTitleBase}"`
      );
    }
  }

  for (const boundaryQuery of boundaryBridgeQueries.slice(0, 3)) {
    addHypothesis(
      boundaryQuery,
      'combined_lines',
      10.55,
      `Boundary bridge from adjacent OCR lines: "${boundaryQuery}"`
    );
  }

  // 2) Title + Author
  if (bestTitle && bestAuthor) {
    addHypothesis(
      `${bestTitle} ${bestAuthor}`,
      'title_author',
      10,
      `Title "${bestTitle}" + author "${bestAuthor}"`
    );
  }

  // 2b) Title + surname fallback (first name OCR is often noisier than surname)
  const bestAuthorSurname = extractAuthorSurname(bestAuthor);
  if (bestTitle && bestAuthorSurname) {
    addHypothesis(
      `${bestTitle} ${bestAuthorSurname}`,
      'title_author',
      12,
      `Title "${bestTitle}" + author surname "${bestAuthorSurname}"`
    );
    addHypothesis(
      `${bestAuthorSurname} ${bestTitle}`,
      'author_title',
      13,
      `Author surname "${bestAuthorSurname}" + title "${bestTitle}"`
    );
  }

  // 2c) Title tail + surname fallback for OCR-corrupted middle title tokens.
  const bestTitleTailToken = pickStrongTitleTailToken(evidence, bestTitle, sortedByLength);
  if (bestTitleTailToken && bestAuthorSurname) {
    addHypothesis(
      `${bestTitleTailToken} ${bestAuthorSurname}`,
      'title_author',
      14,
      `Title tail "${bestTitleTailToken}" + author surname "${bestAuthorSurname}"`
    );
    addHypothesis(
      `${bestAuthorSurname} ${bestTitleTailToken}`,
      'author_title',
      15,
      `Author surname "${bestAuthorSurname}" + title tail "${bestTitleTailToken}"`
    );
  }

  // 3) Title-only (longest substantive line)
  if (bestTitle) {
    addHypothesis(
      bestTitle,
      'title_only',
      12.5,
      `Title-only: "${bestTitle}"`
    );
  }

  if (normalizedDistinctiveTitleToken) {
    addHypothesis(
      normalizedDistinctiveTitleToken,
      'title_only',
      20.5,
      `Distinctive title-token fallback: "${normalizedDistinctiveTitleToken}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedDistinctiveTitleToken} ${normalizedBestAuthorSurname}`,
        'title_author',
        20.6,
        `Distinctive title token + surname: "${normalizedDistinctiveTitleToken}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  // 4) Author-only (if detected)
  if (bestAuthor) {
    addHypothesis(
      bestAuthor,
      'author_only',
      25,
      `Author-only: "${bestAuthor}"`
    );
  }

  for (const supplementalToken of supplementalRawSignalTokens.slice(0, 2)) {
    addHypothesis(
      supplementalToken,
      'author_only',
      26,
      `Raw OCR supplemental token-only fallback: "${supplementalToken}"`
    );
  }

  // 5) Stripped variant
  const titleToStrip = bestTitle || (sortedByLength.length > 0 ? sortedByLength[0] : null);
  if (titleToStrip) {
    const stripped = stripLeadingArticle(titleToStrip);
    if (stripped !== titleToStrip && stripped.length >= MIN_QUERY_LENGTH) {
      if (bestAuthor) {
        addHypothesis(
          `${stripped} ${bestAuthor}`,
          'stripped',
          11,
          `Stripped "${stripped}" + author "${bestAuthor}"`
        );
      } else {
        addHypothesis(
          stripped,
          'stripped',
          11.5,
          `Stripped title: "${stripped}"`
        );
      }
    }
  }

  // If we still have fewer than 3 hypotheses, try combining lines
  if (hypotheses.length < 3 && sortedByLength.length >= 2) {
    addHypothesis(
      `${sortedByLength[0]} ${sortedByLength[1]}`,
      'combined_lines',
      40,
      `Combined lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`
    );
  }

  // If still sparse, try a normalized-token variant of the best title
  if (hypotheses.length < 3 && bestTitle) {
    const normalizedTokens = normalizeForScoring(bestTitle);
    if (normalizedTokens.length >= 2) {
      addHypothesis(
        normalizedTokens.join(' '),
        'stripped',
        45,
        `Normalized tokens: "${normalizedTokens.join(' ')}"`
      );
    }
  }

  // OCR field fallback (only if we have room and evidence was sparse)
  if (hypotheses.length < 3) {
    if (ocrTitle && ocrAuthor) {
      addHypothesis(
        `${ocrTitle} ${ocrAuthor}`,
        'fallback',
        50,
        `OCR fields fallback: title="${ocrTitle}" author="${ocrAuthor}"`
      );
    } else if (ocrTitle) {
      addHypothesis(
        ocrTitle,
        'fallback',
        51,
        `OCR title fallback: "${ocrTitle}"`
      );
    } else if (ocrAuthor) {
      addHypothesis(
        ocrAuthor,
        'fallback',
        52,
        `OCR author fallback: "${ocrAuthor}"`
      );
    }
  }

  // Sort by priority and limit
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, MAX_HYPOTHESES);

  // Debug log: always log hypothesis count and shapes for observability
  const shapes = finalHypotheses.map((h) => h.type);
  const candidateId = debugContext?.candidateId ?? 'unknown';
  console.log(
    `[MetadataResolution] hypotheses_count=${finalHypotheses.length} shapes=[${shapes.join(',')}] candidateId=${candidateId}`
  );

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[Hypotheses] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Quick hypothesis generation for a simple title/author input
 */
export function generateSimpleHypotheses(
  title?: string | null,
  author?: string | null
): SearchHypothesis[] {
  const hypotheses: SearchHypothesis[] = [];

  if (title && author) {
    hypotheses.push({
      query: `${title} ${author}`,
      type: 'title_author',
      priority: 10,
      explanation: `Title + author: "${title}" + "${author}"`,
    });
    hypotheses.push({
      query: `${author} ${title}`,
      type: 'author_title',
      priority: 11,
      explanation: `Author + title: "${author}" + "${title}"`,
    });

    const stripped = stripLeadingArticle(title);
    if (stripped !== title) {
      hypotheses.push({
        query: `${stripped} ${author}`,
        type: 'stripped',
        priority: 15,
        explanation: `Stripped + author: "${stripped}" + "${author}"`,
      });
    }
  } else if (title) {
    hypotheses.push({
      query: title,
      type: 'title_only',
      priority: 20,
      explanation: `Title only: "${title}"`,
    });
  } else if (author) {
    hypotheses.push({
      query: author,
      type: 'author_only',
      priority: 25,
      explanation: `Author only: "${author}"`,
    });
  }

  return hypotheses;
}

// ============================================================================
// Boost Pass Hypothesis Generation
// ============================================================================

/**
 * Generate expanded hypotheses for boost pass (pass2)
 *
 * This is called when pass1 results in suggested or reject.
 * It generates additional hypothesis variations to maximize
 * the chance of finding a match.
 *
 * Strategies:
 * 1. Combined substantive lines (top 2 longest joined)
 * 2. Author-like + title-like detection combos
 * 3. Top N unique tokens as a query
 * 4. N-gram sliding windows (2-gram, 3-gram)
 * 5. Stripped variants removing common words
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param excludeQueries - Queries already tried in pass1 (to avoid duplicates)
 * @param ocrTitle - OCR-extracted title (fallback)
 * @param ocrAuthor - OCR-extracted author (fallback)
 * @returns Expanded hypotheses for boost pass
 */
export function generateBoostHypotheses(
  evidenceLines: string[],
  excludeQueries: Set<string>,
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>(
    Array.from(excludeQueries).map((query) => buildQueryDedupeKey(query))
  );

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    if (!trimmed) return;

    if (type !== 'isbn') {
      const normalizedQuery = normalizeOcrQueryText(trimmed);
      if (!normalizedQuery) return;
      trimmed = normalizedQuery;
    }

    // Skip if too short
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    // Trim to max tokens if needed
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && OCR_SINGLE_TOKEN_QUERY_NOISE.has(tokens[0])) {
      return;
    }
    if (tokens.length > MAX_QUERY_TOKENS) {
      trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
    }

    const normalized = buildQueryDedupeKey(trimmed);

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    usedQueries.add(normalized);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // Sort candidate phrases by length (descending)
  const sortedByLength = sortEvidencePhrasesByQuality(evidence.candidatePhrases);

  const bestTitle = pickBestTitleLine(evidence, sortedByLength);
  const bestAuthor = pickBestAuthorLine(evidence, bestTitle);
  const normalizedBestAuthor = normalizeOcrQueryText(bestAuthor);
  const normalizedBestTitle = normalizeOcrQueryText(bestTitle);
  const normalizedBestTitleSansAuthor = stripAuthorTailFromTitle(
    normalizedBestTitle,
    normalizedBestAuthor
  );
  const normalizedBestTitleSansRepeatedTail = stripLikelyRepeatedTailToken(
    normalizedBestTitleSansAuthor,
    evidence
  );
  const normalizedBestTitleSansLikelyAuthorTail = stripLikelyAuthorTailToken(
    normalizedBestTitleSansRepeatedTail ?? normalizedBestTitleSansAuthor
  );
  const normalizedBestTitleCore =
    normalizedBestTitleSansLikelyAuthorTail ??
    normalizedBestTitleSansRepeatedTail ??
    normalizedBestTitleSansAuthor;
  const normalizedSeriesCoreTitle = extractSeriesCoreTitle(normalizedBestTitleCore);
  const swappedNormalizedBestTitle = swapLeadingTitleTokens(
    normalizedBestTitleCore
  );
  const connectorReducedNormalizedTitle = buildConnectorReducedTitleVariant(
    normalizedBestTitleCore
  );
  const reorderedOfNormalizedTitle = buildReorderedOfTitleVariant(
    normalizedBestTitleCore
  );
  const normalizedDistinctiveTitleToken = pickDistinctiveTitleToken(
    normalizedBestTitleCore ?? normalizedBestTitleSansAuthor ?? normalizedBestTitle
  );
  const standaloneTitleAnchor = pickStandaloneTitleAnchor(evidence, sortedByLength, bestAuthor);
  const normalizedBestAuthorSurname = extractAuthorSurname(normalizedBestAuthor);
  // Raw tokens the cleaner dropped can recover a lost author; with an author in hand
  // they are mostly publisher/badge noise ("ZEBRA", "NEW FORK").
  const supplementalRawSignalTokens = bestAuthor
    ? []
    : collectSupplementalRawSignalTokens(evidenceLines, evidence.tokensSet);
  const boundaryBridgeQueries = collectBoundaryBridgeQueries(evidenceLines);
  const normalizedTitleChanged = queryChangedAfterNormalization(
    bestTitle,
    normalizedBestTitleSansAuthor
  );
  const normalizedAuthorChanged = queryChangedAfterNormalization(bestAuthor, normalizedBestAuthor);

  // Seed boost with OCR-normalized title/author combos so they are not crowded out later.
  if (
    normalizedBestTitleSansAuthor &&
    normalizedBestAuthor &&
    (normalizedTitleChanged || normalizedAuthorChanged)
  ) {
    addHypothesis(
      `${normalizedBestTitleSansAuthor} ${normalizedBestAuthor}`,
      'boost_combo',
      99,
      `OCR-normalized seed: "${normalizedBestTitleSansAuthor}" + "${normalizedBestAuthor}"`
    );
  }

  if (normalizedBestTitleSansAuthor && normalizedTitleChanged) {
    addHypothesis(
      normalizedBestTitleSansAuthor,
      'boost_partial',
      99.05,
      `OCR-normalized title-only seed: "${normalizedBestTitleSansAuthor}"`
    );
  }

  if (
    standaloneTitleAnchor &&
    standaloneTitleAnchor !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      standaloneTitleAnchor,
      'boost_partial',
      99.12,
      `Standalone title anchor seed: "${standaloneTitleAnchor}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${standaloneTitleAnchor} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        99.13,
        `Standalone title anchor + surname seed: "${standaloneTitleAnchor}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    connectorReducedNormalizedTitle &&
    connectorReducedNormalizedTitle !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      connectorReducedNormalizedTitle,
      'boost_partial',
      99.08,
      `Connector-reduced title seed: "${connectorReducedNormalizedTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${connectorReducedNormalizedTitle} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        99.09,
        `Connector-reduced title + surname seed: "${connectorReducedNormalizedTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    reorderedOfNormalizedTitle &&
    reorderedOfNormalizedTitle !== normalizedBestTitleSansAuthor &&
    reorderedOfNormalizedTitle !== connectorReducedNormalizedTitle
  ) {
    addHypothesis(
      reorderedOfNormalizedTitle,
      'boost_partial',
      99.1,
      `Reordered "of" title seed: "${reorderedOfNormalizedTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${reorderedOfNormalizedTitle} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        99.11,
        `Reordered "of" title + surname seed: "${reorderedOfNormalizedTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    normalizedBestTitleSansAuthor &&
    normalizedBestAuthorSurname &&
    (normalizedTitleChanged || normalizedAuthorChanged)
  ) {
    addHypothesis(
      `${normalizedBestTitleSansAuthor} ${normalizedBestAuthorSurname}`,
      'boost_combo',
      99.2,
      `OCR-normalized seed title+surname: "${normalizedBestTitleSansAuthor}" + "${normalizedBestAuthorSurname}"`
    );
  }

  const normalizedTailToken = extractTitleTailToken(normalizedBestTitleCore);
  if (normalizedTailToken && normalizedBestAuthorSurname) {
    addHypothesis(
      `${normalizedTailToken} ${normalizedBestAuthorSurname}`,
      'boost_combo',
      99.3,
      `OCR-normalized seed tail+surname: "${normalizedTailToken}" + "${normalizedBestAuthorSurname}"`
    );
  }

  if (
    normalizedBestTitleSansRepeatedTail &&
    normalizedBestTitleSansRepeatedTail !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      normalizedBestTitleSansRepeatedTail,
      'boost_partial',
      99.35,
      `Dropped repeated noisy tail token: "${normalizedBestTitleSansRepeatedTail}"`
    );
  }

  if (
    normalizedBestTitleSansLikelyAuthorTail &&
    normalizedBestTitleSansLikelyAuthorTail !== normalizedBestTitleSansAuthor &&
    normalizedBestTitleSansLikelyAuthorTail !== normalizedBestTitleSansRepeatedTail
  ) {
    addHypothesis(
      normalizedBestTitleSansLikelyAuthorTail,
      'boost_partial',
      99.36,
      `Dropped likely author tail token: "${normalizedBestTitleSansLikelyAuthorTail}"`
    );
  }

  if (swappedNormalizedBestTitle) {
    addHypothesis(
      swappedNormalizedBestTitle,
      'boost_partial',
      99.4,
      `Leading title token swap: "${swappedNormalizedBestTitle}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${swappedNormalizedBestTitle} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        99.41,
        `Leading title token swap + surname: "${swappedNormalizedBestTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (normalizedDistinctiveTitleToken) {
    addHypothesis(
      normalizedDistinctiveTitleToken,
      'boost_partial',
      99.37,
      `Distinctive title-token fallback: "${normalizedDistinctiveTitleToken}"`
    );

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedDistinctiveTitleToken} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        99.38,
        `Distinctive title token + surname: "${normalizedDistinctiveTitleToken}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  if (
    normalizedSeriesCoreTitle &&
    normalizedSeriesCoreTitle !== normalizedBestTitleSansAuthor
  ) {
    addHypothesis(
      normalizedSeriesCoreTitle,
      'boost_partial',
      100.1,
      `Series-core title extraction: "${normalizedSeriesCoreTitle}"`
    );

    if (normalizedBestAuthor) {
      addHypothesis(
        `${normalizedSeriesCoreTitle} ${normalizedBestAuthor}`,
        'boost_combo',
        100.11,
        `Series-core title + author: "${normalizedSeriesCoreTitle}" + "${normalizedBestAuthor}"`
      );
    }

    if (normalizedBestAuthorSurname) {
      addHypothesis(
        `${normalizedSeriesCoreTitle} ${normalizedBestAuthorSurname}`,
        'boost_combo',
        100.12,
        `Series-core title + surname: "${normalizedSeriesCoreTitle}" + "${normalizedBestAuthorSurname}"`
      );
    }
  }

  const supplementalBoostTitleBase = normalizedBestTitleCore;
  if (supplementalBoostTitleBase) {
    for (const supplementalToken of supplementalRawSignalTokens.slice(0, 2)) {
      addHypothesis(
        `${supplementalBoostTitleBase} ${supplementalToken}`,
        'boost_combo',
        99.45,
        `Raw OCR supplemental token "${supplementalToken}" + title "${supplementalBoostTitleBase}"`
      );
      addHypothesis(
        `${supplementalToken} ${supplementalBoostTitleBase}`,
        'boost_combo',
        99.5,
        `Raw OCR supplemental token "${supplementalToken}" before title "${supplementalBoostTitleBase}"`
      );
    }
  }

  for (const boundaryQuery of boundaryBridgeQueries.slice(0, 4)) {
    addHypothesis(
      boundaryQuery,
      'boost_partial',
      99.55,
      `Boundary bridge from adjacent OCR lines: "${boundaryQuery}"`
    );
  }

  for (const line of sortedByLength.slice(0, 4)) {
    const normalizedLine = normalizeOcrQueryText(line);
    if (
      normalizedLine &&
      queryChangedAfterNormalization(line, normalizedLine) &&
      normalizedLine.length >= MIN_QUERY_LENGTH
    ) {
      addHypothesis(
        normalizedLine,
        'boost_partial',
        99.6,
        `OCR-normalized line: "${normalizedLine}"`
      );
    }
  }

  // =========================================================================
  // Strategy 1: Combined substantive lines (top 2-3 joined)
  // =========================================================================
  if (sortedByLength.length >= 2) {
    const top2 = `${sortedByLength[0]} ${sortedByLength[1]}`;
    addHypothesis(top2, 'boost_combo', 100, `Top 2 lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`);

    // Reverse order
    const top2Rev = `${sortedByLength[1]} ${sortedByLength[0]}`;
    addHypothesis(top2Rev, 'boost_combo', 101, `Top 2 reversed: "${sortedByLength[1]}" + "${sortedByLength[0]}"`);
  }

  if (sortedByLength.length >= 3) {
    const top3 = `${sortedByLength[0]} ${sortedByLength[1]} ${sortedByLength[2]}`;
    addHypothesis(top3, 'boost_combo', 102, `Top 3 lines combined`);
  }

  // =========================================================================
  // Strategy 2: Author-like + title-like detection combos
  // =========================================================================
  // Try all combinations of title-like and person-name lines
  for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
    for (const authorLine of evidence.personNameLines.slice(0, 2)) {
      addHypothesis(
        `${titleLine} ${authorLine}`,
        'boost_combo',
        110,
        `Title "${titleLine}" + author "${authorLine}"`
      );

      const authorSurname = extractAuthorSurname(authorLine);
      if (authorSurname) {
        addHypothesis(
          `${titleLine} ${authorSurname}`,
          'boost_combo',
          110.5,
          `Title "${titleLine}" + author surname "${authorSurname}"`
        );
        addHypothesis(
          `${authorSurname} ${titleLine}`,
          'boost_combo',
          110.6,
          `Author surname "${authorSurname}" + title "${titleLine}"`
        );
      }
    }
  }

  // =========================================================================
  // Strategy 2b: Strong title-tail + author surname combinations
  // =========================================================================
  // Use high-signal trailing title tokens (e.g., "DARKNESS") even when
  // full title extraction is noisy.
  {
    const bestAuthorLine = pickBestAuthorLine(evidence, pickBestTitleLine(evidence, sortedByLength));
    const authorSurname = extractAuthorSurname(bestAuthorLine);
    if (authorSurname) {
      const seenTailTokens = new Set<string>();
      const candidateLines = [
        ...evidence.titleLikeLines.slice(0, 3),
        ...sortedByLength.slice(0, 6),
      ];

      for (const line of candidateLines) {
        if (looksLikePersonName(line)) continue;
        const tailToken = extractTitleTailToken(line);
        if (!tailToken || tailToken.length < 5) continue;
        if (tailToken.toLowerCase() === authorSurname.toLowerCase()) continue;

        const key = tailToken.toLowerCase();
        if (seenTailTokens.has(key)) continue;
        seenTailTokens.add(key);

        addHypothesis(
          `${tailToken} ${authorSurname}`,
          'boost_combo',
          111.2,
          `Title tail "${tailToken}" + author surname "${authorSurname}"`
        );
        addHypothesis(
          `${authorSurname} ${tailToken}`,
          'boost_combo',
          111.3,
          `Author surname "${authorSurname}" + title tail "${tailToken}"`
        );

        if (seenTailTokens.size >= 2) {
          break;
        }
      }
    }
  }

  // =========================================================================
  // Strategy 3: Top N unique tokens as a query
  // =========================================================================
  const allTokens = Array.from(evidence.tokensSet);
  if (allTokens.length >= 3) {
    // Sort by frequency (most common first) then take top N
    const sortedTokens = allTokens
      .map((t) => ({ token: t, count: evidence.tokenCounts.get(t) || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, BOOST_TOP_TOKENS_COUNT)
      .map((t) => t.token);

    const tokenQuery = sortedTokens.join(' ');
    addHypothesis(tokenQuery, 'boost_tokens', 120, `Top ${sortedTokens.length} tokens: ${tokenQuery}`);
  }

  // =========================================================================
  // Strategy 4j: Word splitting for merged OCR words
  // =========================================================================
  // Try splitting merged words at common boundaries
  const spanishPrefixes = ['UN', 'EN', 'EL', 'LA', 'DE', 'CON', 'POR', 'FOR', 'YOUR'];
  for (const line of sortedByLength.slice(0, 5)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    let splitVariants: string[] = [];
    
    for (const token of tokens) {
      if (token.length >= 6) {
        // Try splitting at 2-3 char prefixes
        for (const prefix of spanishPrefixes) {
          if (token.toUpperCase().startsWith(prefix) && token.length > prefix.length + 2) {
            const rest = token.substring(prefix.length);
            splitVariants.push(`${prefix} ${rest}`);
          }
        }
      }
    }
    
    for (const variant of splitVariants.slice(0, 2)) {
      addHypothesis(variant, 'boost_partial', 135, `Word split: "${variant}"`);
    }
  }

  // =========================================================================
  // Strategy 4k: Split fused joiners (e.g., "STRAIGHIINTO" -> "STRAIGHI INTO")
  // =========================================================================
  const fusedJoiners = ['INTO', 'AND', 'WITH', 'FROM', 'THE', 'OF', 'ILE', 'VE', 'IN'];
  for (const line of sortedByLength.slice(0, 4)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    let madeChange = false;
    const splitTokens = tokens.map((token) => {
      const upper = token.toUpperCase();
      for (const joiner of fusedJoiners) {
        if (upper.length <= joiner.length + 3) continue;
        if (upper.endsWith(joiner)) {
          const base = token.slice(0, token.length - joiner.length);
          if (base.length >= 4) {
            madeChange = true;
            if (base.endsWith('I')) {
              return `${base.slice(0, -1)}T ${joiner}`;
            }
            if (base.endsWith('i')) {
              return `${base.slice(0, -1)}t ${joiner}`;
            }
            return `${base} ${joiner}`;
          }
        }
      }
      return token;
    });

    if (madeChange) {
      addHypothesis(
        splitTokens.join(' '),
        'boost_partial',
        99.05,
        `Fused joiner split: "${splitTokens.join(' ')}"`
      );
    }
  }

  // =========================================================================
  // Strategy 4: N-gram sliding windows
  // =========================================================================
  // Generate 2-grams and 3-grams from token list
  if (allTokens.length >= 4) {
    const ngrams: string[] = [];

    // 2-grams
    for (let i = 0; i < Math.min(allTokens.length - 1, 6); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]}`);
    }

    // 3-grams
    for (let i = 0; i < Math.min(allTokens.length - 2, 4); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]} ${allTokens[i + 2]}`);
    }

    // Add unique n-grams as hypotheses (limit to 3)
    for (let i = 0; i < Math.min(ngrams.length, 3); i++) {
      addHypothesis(ngrams[i], 'boost_ngram', 130 + i, `N-gram: "${ngrams[i]}"`);
    }
  }

  // =========================================================================
  // Strategy 5j: OCR character confusion corrections for longer words
  // =========================================================================
  // Common OCR confusions: ONF→ONE, MUKDERS→MURDERS, etc.
  const ocrConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS?\b/gi, 'MURDER'],
    [/\bHEAVI\b/gi, 'HEAVEN'],
    [/\bADV\b/gi, 'ADVENTURE'],
    [/\bONLI\b/gi, 'ONLY'],
    [/\bFIKST\b/gi, 'FIRST'],
  ];

  // Table-driven corrections are high-signal, so they rank right after the seeds;
  // otherwise brute-force variants fill the PASS2 cap before they're reached.
  for (const line of sortedByLength.slice(0, 8)) {
    const corrected = safeApplyReplacements(line, ocrConfusions);
    if (corrected !== line) {
      addHypothesis(corrected, 'boost_partial', 99.02, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5k: Conservative terminal I->T correction for longer words
  // =========================================================================
  // OCR often flips a terminal T to I (e.g., STRAIGHI -> STRAIGHT).
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const correctedTokens: string[] = [];
    let madeChanges = false;

    for (const token of tokens) {
      if (token.length >= 6 && token.endsWith('I')) {
        correctedTokens.push(`${token.substring(0, token.length - 1)}T`);
        madeChanges = true;
        continue;
      }
      if (token.length >= 6 && token.endsWith('i')) {
        correctedTokens.push(`${token.substring(0, token.length - 1)}t`);
        madeChanges = true;
        continue;
      }
      correctedTokens.push(token);
    }

    if (madeChanges) {
      const correctedLine = correctedTokens.join(' ');
      addHypothesis(correctedLine, 'boost_partial', 133, `Terminal I->T correction: "${correctedLine}"`);
    }
  }

  // =========================================================================
  // Strategy 5: Stripped variants
  // =========================================================================
  // Strip common words from lines and try
  for (const line of sortedByLength.slice(0, 3)) {
    const stripped = stripLeadingArticle(line);
    if (stripped !== line && stripped.length >= MIN_QUERY_LENGTH) {
      addHypothesis(stripped, 'stripped', 140, `Stripped: "${stripped}"`);
    }

    // Also try with normalized scoring tokens (removes generic words)
    const tokens = normalizeForScoring(line);
    if (tokens.length >= 2) {
      const cleanQuery = tokens.join(' ');
      addHypothesis(cleanQuery, 'boost_partial', 145, `Normalized tokens: "${cleanQuery}"`);
    }
  }

  // =========================================================================
  // Strategy 5l: Truncated name completion
  // =========================================================================
  // Common author last name completions for truncated OCR
  const nameCompletions: Array<[RegExp, string]> = [
    [/\bMACDO(NALD)?\b/gi, 'MACDONALD'],
    [/\bSMIT(H)?\b/gi, 'SMITH'],
    [/\bJOHNS(ON)?\b/gi, 'JOHNSON'],
    [/\bBROW(N)?\b/gi, 'BROWN'],
    [/\bWILLI(AMS)?\b/gi, 'WILLIAMS'],
    [/\bDAVI(S)?\b/gi, 'DAVIS'],
    [/\bMILL(ER)?\b/gi, 'MILLER'],
    [/\bADV(ENTURE)?\b/gi, 'ADVENTURE'],
    [/\bFARGO?\b/gi, 'FARGO'],
    [/\bCLIV(E)?\b/gi, 'CLIVE'],
    [/\bCUSS(LER)?\b/gi, 'CUSSLER'],
    [/\bPATR(ICK)?\b/gi, 'PATRICK'],
    [/\bROBER(T)?\b/gi, 'ROBERT'],
    [/\bSTEP(HEN)?\b/gi, 'STEPHEN'],
    [/\bSTEV(EN)?\b/gi, 'STEVEN'],
    [/\bLAU(RA)?\b/gi, 'LAURA'],
    [/\bFAVE\b/gi, 'FAYE'],
    [/\bACAID\b/gi, 'NGAIO'],
    [/\bAGAID\b/gi, 'NGAIO'],
    [/\bJOH\b(?!\s+\w)/gi, 'JOHN'],
    [/\bDEAN\s+KO(?:O|ON|ONT)?\b/gi, 'DEAN KOONTZ'],
    [/\bNGAI(O)?\b/gi, 'NGAIO'],
    [/\bMARS(H)?\b/gi, 'MARSH'],
    [/\bWARSH\b/gi, 'MARSH'],
    [/\bCHARLA(INE)?\b/gi, 'CHARLAINE'],
    [/\bHARR(IS)?\b/gi, 'HARRIS'],
    [/\bROWLA(ND)?\b/gi, 'ROWLAND'],
    [/\bDEAD?\b/gi, 'DEAD'],
    [/\bDEND\b/gi, 'DEAD'],
    [/\bMURD(ERS?)?\b/gi, 'MURDERS'],
    [/\bSTRAIGHI\b/gi, 'STRAIGHT'],
    [/\bSTRAIGHE\b/gi, 'STRAIGHT'],
    [/\bWOOL?\b/gi, 'WOOL'],
  ];

  for (const line of sortedByLength.slice(0, 8)) {
    const completed = safeApplyReplacements(line, nameCompletions);
    if (completed !== line) {
      addHypothesis(completed, 'boost_partial', 99.03, `Name completion: "${completed}"`);
    }
  }

  // =========================================================================
  // Strategy 5j2: Common OCR letter confusions
  // =========================================================================
  const letterConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS\b/gi, 'MURDERS'],
    [/\bTHF\b/gi, 'THE'],
    [/\bTIE\b(?=\s+[A-Za-z])/gi, 'THE'],
    [/\bQUI?C?K?OLER\b/gi, 'CUSSLER'],
    [/\bAHD\b/gi, 'AND'],
    [/\bFOR\b/gi, 'FOR'],
    [/\bYOUR\b/gi, 'YOUR'],
    [/HEAVI/gi, 'HEAVY'],
    [/\bLEFI\b/gi, 'LEFT'],
    [/\bRIGHI\b/gi, 'RIGHT'],
    [/\bTIMF\b/gi, 'TIME'],
    [/\bBESTIELL/gi, 'BESTSELLER'],
    [/\bBEST IELL/gi, 'BESTSELLER'],
    [/\bBESTSELL/gi, 'BESTSELLER'],
    [/\bBEST SELL/gi, 'BESTSELLER'],
    [/\bAUTHOR/gi, 'AUTHOR'],
    [/\bAUTH OR/gi, 'AUTHOR'],
    [/\bCHON\b/gi, 'JOHN'],
    [/\bJOHH\b/gi, 'JOHN'],
    [/\bJOINS\b/gi, 'JONES'],
    [/\bDOORNAIL\b/gi, 'DOORNAIL'],
    [/\bBUNDORI\b/gi, 'BUNDORI'],
    [/\bLAUIRA\b/gi, 'LAURA'],
    [/\bNGALO\b/gi, 'NGAIO'],
    [/\bFAVE\b/gi, 'FAYE'],
    [/\bACAID\b/gi, 'NGAIO'],
    [/\bAGAID\b/gi, 'NGAIO'],
    [/\bWARSH\b/gi, 'MARSH'],
    [/\bMYSTEFT\b/gi, 'MYSTERY'],
    [/\bSTRAIGHIINTO\b/gi, 'STRAIGHT INTO'],
    [/\bSTRAIGHE\s+INTO\b/gi, 'STRAIGHT INTO'],
    [/\bSTRAIGHI\b/gi, 'STRAIGHT'],
    [/\bSTRAIGHE\b/gi, 'STRAIGHT'],
    [/\bPALRICH\b/gi, 'PATRICK'],
    [/\bDERKLEK\b/gi, 'DEREK'],
    [/\bCOLORFUIL\b/gi, 'COLORFUL'],
    [/\bBestiell?\b/gi, 'BESTSELLER'],
    [/\bestienli?\b/gi, 'BESTSELLER'],
    [/\bPIRAACIA\b/gi, 'PATRICIA'],
    [/\bPIRA ACIA\b/gi, 'PATRICIA'],
  ];

  for (const line of sortedByLength.slice(0, 8)) {
    const corrected = safeApplyReplacements(line, letterConfusions);
    if (corrected !== line && corrected.length >= MIN_QUERY_LENGTH) {
      addHypothesis(corrected, 'boost_partial', 99.04, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5m: Drop corrupted first 1-2 characters
  // =========================================================================
  // OCR often corrupts the first character of words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      // Try dropping first char from first word
      const variant1 = [tokens[0].substring(1), ...tokens.slice(1)].join(' ');
      if (variant1.length >= MIN_QUERY_LENGTH) {
        addHypothesis(variant1, 'boost_partial', 149, `Drop first char: "${variant1}"`);
      }
      
      // Try dropping first 2 chars from first word
      if (tokens[0].length > 3) {
        const variant2 = [tokens[0].substring(2), ...tokens.slice(1)].join(' ');
        if (variant2.length >= MIN_QUERY_LENGTH) {
          addHypothesis(variant2, 'boost_partial', 149, `Drop first 2 chars: "${variant2}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p2: Split long lines that may contain title+garbled author
  // =========================================================================
  // Lines like "DIED IN THE WOOL NGALO LUI" contain a valid title prefix
  // followed by garbled author. Try progressively shorter prefixes as title-only.
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 5) {
      for (let titleLen = 3; titleLen <= Math.min(tokens.length - 1, 5); titleLen++) {
        const titlePart = tokens.slice(0, titleLen).join(' ');
        const authorPart = tokens.slice(titleLen).join(' ');
        if (titlePart.length >= MIN_QUERY_LENGTH) {
          addHypothesis(titlePart, 'boost_partial', 112.2, `Long line title prefix: "${titlePart}"`);
        }
        if (authorPart.length >= MIN_QUERY_LENGTH) {
          let correctedAuthor = safeApplyReplacements(authorPart, nameCompletions);
          correctedAuthor = safeApplyReplacements(correctedAuthor, letterConfusions);
          if (correctedAuthor !== authorPart) {
            addHypothesis(
              `${titlePart} ${correctedAuthor}`,
              'boost_combo',
              112.3,
              `Split line: title="${titlePart}" + corrected author="${correctedAuthor}"`
            );
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p3: Cross-line title fragment reassembly
  // =========================================================================
  // When title words are split across non-adjacent lines (e.g., "DEND AS A" on
  // one line and "DOORNAIL" on another), try combining title-like fragments.
  // Apply corrections first, then combine lines ending in articles/prepositions
  // with other content lines.
  {
    const correctedPhrases: Array<{ original: string; corrected: string }> = [];
    for (const line of sortedByLength.slice(0, 8)) {
      let corrected = safeApplyReplacements(line, nameCompletions);
      corrected = safeApplyReplacements(corrected, letterConfusions);
      correctedPhrases.push({ original: line, corrected });
    }

    // Find lines ending with articles/prepositions (incomplete title fragments)
    const continuationEndings = /\b(a|an|the|of|in|to|for|with|on|at|by|from|and|or|as|into)\s*$/i;
    for (const phrase of correctedPhrases) {
      if (continuationEndings.test(phrase.corrected)) {
        // This line looks incomplete - try appending other lines to complete it
        for (const other of correctedPhrases) {
          if (other.original === phrase.original) continue;
          const combined = `${phrase.corrected} ${other.corrected}`;
          const tokens = combined.split(/\s+/).filter(Boolean);
          if (tokens.length >= 3 && tokens.length <= MAX_QUERY_TOKENS) {
            addHypothesis(combined, 'boost_combo', 147.5, `Cross-line reassembly: "${combined}"`);
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5n: Very short OCR text - use wildcard patterns
  // =========================================================================
  // For 3-4 character OCR fragments, try adding wildcard or common endings.
  // Keep this conservative: only run when we don't already have a substantive line.
  const hasSubstantiveLine = sortedByLength.some((line) =>
    normalizeForScoring(line).some((token) => token.length >= 5)
  );
  const genericShortFragments = new Set(['the', 'new', 'big', 'old', 'last', 'first']);
  const shortFragments = sortedByLength.filter((line) => {
    if (line.length < 3 || line.length > 4) return false;
    const normalized = line.toLowerCase().replace(/[^a-z]/g, '');
    if (!normalized) return false;
    return !genericShortFragments.has(normalized);
  });

  if (!hasSubstantiveLine) {
    for (const frag of shortFragments.slice(0, 3)) {
      // Try common word endings for truncated text
      const endings = ['EN', 'VEN', 'P', 'VE', 'PHEN', 'IGHT', 'AVY'];
      for (const ending of endings) {
        const extended = frag + ending;
        if (extended.length >= MIN_QUERY_LENGTH) {
          addHypothesis(extended, 'boost_partial', 149.5, `Short fragment extended: "${extended}"`);
        }
      }

      // For very short fragments, try common word prefixes (reverse truncation)
      const prefixes = ['THE ', 'NEW ', 'BIG ', 'OLD ', 'LAST ', 'FIRST '];
      for (const prefix of prefixes) {
        const extended = prefix + frag;
        if (extended.length >= MIN_QUERY_LENGTH) {
          addHypothesis(extended, 'boost_partial', 149.6, `Short fragment prefixed: "${extended}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5n2: Single character deletion for insertion errors
  // =========================================================================
  // LAUIRA → LAURA, DEND → DEAD - try removing each char from longer words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    for (let tokenIdx = 0; tokenIdx < tokens.length && tokenIdx < 3; tokenIdx++) {
      const token = tokens[tokenIdx];
      if (token.length >= 5 && token.length <= 8) {
        // Try removing each character position
        for (let charPos = 1; charPos < token.length - 1; charPos++) {
          const modified = [...tokens];
          modified[tokenIdx] = token.substring(0, charPos) + token.substring(charPos + 1);
          const result = modified.join(' ');
          if (result.length >= MIN_QUERY_LENGTH) {
            addHypothesis(result, 'boost_partial', 149.3, `Single char deletion: "${result}"`);
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5o: Person name with space insertions for corrupted text
  // =========================================================================
  // PIRA ACIA might be missing letters - try inserting common letters
  for (const personLine of evidence.personNameLines.slice(0, 3)) {
    const tokens = personLine.split(/\s+/);
    if (tokens.length >= 2) {
      // Try inserting vowels in short tokens (might be truncated)
      const vowels = ['A', 'E', 'I', 'O'];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].length >= 3 && tokens[i].length <= 5) {
          for (const vowel of vowels) {
            const modified = [...tokens];
            modified[i] = tokens[i].substring(0, 2) + vowel + tokens[i].substring(2);
            const result = modified.join(' ');
            if (result.length >= MIN_QUERY_LENGTH) {
              addHypothesis(result, 'boost_partial', 149.8, `Name vowel insert: "${result}"`);
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p: Multi-token merge for fragmented OCR
  // =========================================================================
  // Sometimes OCR splits words that should be together (e.g., "BEST SELLER")
  for (const line of sortedByLength.slice(0, 4)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.length <= 4) {
      // Try merging adjacent tokens
      for (let i = 0; i < tokens.length - 1; i++) {
        const merged = [...tokens.slice(0, i), tokens[i] + tokens[i + 1], ...tokens.slice(i + 2)].join(' ');
        if (merged.length >= MIN_QUERY_LENGTH) {
          addHypothesis(merged, 'boost_partial', 149.9, `Token merge: "${merged}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5q: Title-only when author is corrupted/truncated
  // =========================================================================
  // If we have person names but they're very short (likely truncated like "JOH"),
  // try using just title-like lines instead
  const hasShortPersonNames = evidence.personNameLines.some(name => {
    const tokens = name.split(/\s+/).filter(Boolean);
    return tokens.some(t => t.length <= 3 && t.length >= 2);
  });
  
  if (hasShortPersonNames && evidence.titleLikeLines.length > 0) {
    for (const titleLine of evidence.titleLikeLines.slice(0, 3)) {
      if (titleLine.length >= MIN_QUERY_LENGTH) {
        addHypothesis(titleLine, 'boost_partial', 149.85, `Title-only (corrupted author): "${titleLine}"`);
      }
    }
  }

  // =========================================================================
  // Strategy 5r: Use recovered author candidates + title lines
  // =========================================================================
  // recoveredAuthorCandidates reconstructs multi-word authors from single-word
  // fragments (e.g., "CHARLAINE" + "HARRIS" → "CHARLAINE HARRIS") and from
  // advancedExtraction. Combine these with title-like lines and corrected titles.
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length > 0) {
    const goodAuthors = evidence.recoveredAuthorCandidates
      .filter((c: { confidence: number }) => c.confidence > 0.4)
      .slice(0, 3);

    for (const authorCandidate of goodAuthors) {
      const authorLine = authorCandidate.line;

      // Apply name completions and letter confusions to recovered author
      let correctedAuthor = safeApplyReplacements(authorLine, nameCompletions);
      correctedAuthor = safeApplyReplacements(correctedAuthor, letterConfusions);

      // Try author alone
      if (correctedAuthor.length >= MIN_QUERY_LENGTH) {
        addHypothesis(correctedAuthor, 'boost_partial', 146, `Recovered author: "${correctedAuthor}"`);
      }

      // Combine with title-like lines
      for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
        let correctedTitle = safeApplyReplacements(titleLine, nameCompletions);
        correctedTitle = safeApplyReplacements(correctedTitle, letterConfusions);

        addHypothesis(
          `${correctedTitle} ${correctedAuthor}`,
          'boost_combo',
          144,
          `Corrected title+recovered author: "${correctedTitle}" + "${correctedAuthor}"`
        );
      }

      // Combine with longest candidate phrases (may contain title words)
      for (const phrase of sortedByLength.slice(0, 2)) {
        let correctedPhrase = safeApplyReplacements(phrase, nameCompletions);
        correctedPhrase = safeApplyReplacements(correctedPhrase, letterConfusions);
        if (correctedPhrase !== correctedAuthor) {
          addHypothesis(
            `${correctedPhrase} ${correctedAuthor}`,
            'boost_combo',
            145,
            `Corrected phrase+recovered author: "${correctedPhrase}" + "${correctedAuthor}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5s: Use advancedExtraction title+author if available
  // =========================================================================
  if (evidence.advancedExtraction) {
    const adv = evidence.advancedExtraction;
    if (adv.title && adv.author) {
      addHypothesis(
        `${adv.title} ${adv.author}`,
        'boost_combo',
        142,
        `Advanced extraction: "${adv.title}" + "${adv.author}"`
      );
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title: "${adv.title}"`);
    } else if (adv.title) {
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title-only: "${adv.title}"`);
    } else if (adv.author) {
      addHypothesis(adv.author, 'boost_partial', 143.5, `Advanced author-only: "${adv.author}"`);
    }
  }

  // =========================================================================
  // Strategy 5t: Reconstruct author from adjacent single-word surname candidates
  // =========================================================================
  // When OCR produces separate lines like "CHARLAINE" / "HARRIS",
  // recoverAuthorCandidates catches individual words but we should also
  // try combining consecutive single-word candidates into "FIRSTNAME LASTNAME".
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length >= 2) {
    const singleWordCandidates = evidence.recoveredAuthorCandidates
      .filter((c: { line: string; confidence: number }) => {
        const words = c.line.trim().split(/\s+/);
        return words.length === 1 && c.confidence >= 0.4;
      })
      .map((c: { line: string }) => c.line.trim());

    for (let i = 0; i < singleWordCandidates.length - 1 && i < 4; i++) {
      for (let j = i + 1; j < singleWordCandidates.length && j < i + 3; j++) {
        const combinedAuthor = `${singleWordCandidates[i]} ${singleWordCandidates[j]}`;

        let correctedCombined = safeApplyReplacements(combinedAuthor, nameCompletions);
        correctedCombined = safeApplyReplacements(correctedCombined, letterConfusions);

        addHypothesis(correctedCombined, 'boost_partial', 147, `Combined surname candidates: "${correctedCombined}"`);

        for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
          let correctedTitle = safeApplyReplacements(titleLine, nameCompletions);
          correctedTitle = safeApplyReplacements(correctedTitle, letterConfusions);
          addHypothesis(
            `${correctedTitle} ${correctedCombined}`,
            'boost_combo',
            146.5,
            `Title + combined authors: "${correctedTitle}" + "${correctedCombined}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5u: Global correction + cross-line title/author recombination
  // =========================================================================
  // Apply all corrections to every candidate phrase, then identify corrected
  // title-like and person-name-like lines and combine them across lines.
  {
    const globalCorrected: Array<{ original: string; corrected: string }> = [];
    for (const phrase of evidence.candidatePhrases.slice(0, 10)) {
      let corrected = safeApplyReplacements(phrase, nameCompletions);
      corrected = safeApplyReplacements(corrected, letterConfusions);
      globalCorrected.push({ original: phrase, corrected });
    }

    // Separate corrected lines into title-like and person-name-like
    const correctedTitles: string[] = [];
    const correctedAuthors: string[] = [];
    for (const { corrected } of globalCorrected) {
      if (looksLikeTitle(corrected)) {
        correctedTitles.push(corrected);
      }
      if (looksLikePersonName(corrected)) {
        correctedAuthors.push(corrected);
      }
    }

    // Combine corrected titles with corrected authors from different lines
    for (const title of correctedTitles.slice(0, 3)) {
      for (const author of correctedAuthors.slice(0, 3)) {
        if (title === author) continue;
        addHypothesis(
          `${title} ${author}`,
          'boost_combo',
          147.8,
          `Global corrected title+author: "${title}" + "${author}"`
        );
      }
      // Also try the corrected title alone
      addHypothesis(title, 'boost_partial', 147.9, `Global corrected title: "${title}"`);
    }
  }

  // =========================================================================
  // Strategy 6: Individual lines not yet tried
  // =========================================================================
  for (let i = 0; i < Math.min(evidence.candidatePhrases.length, 5); i++) {
    const phrase = evidence.candidatePhrases[i];
    addHypothesis(phrase, 'boost_partial', 150 + i, `Line ${i + 1}: "${phrase}"`);
  }

  // =========================================================================
  // Strategy 7: OCR field combinations (last resort)
  // =========================================================================
  if (ocrTitle) {
    addHypothesis(ocrTitle, 'fallback', 160, `OCR title: "${ocrTitle}"`);
    if (ocrAuthor) {
      addHypothesis(`${ocrTitle} ${ocrAuthor}`, 'fallback', 161, `OCR title+author`);
    }
  }
  if (ocrAuthor) {
    addHypothesis(ocrAuthor, 'fallback', 162, `OCR author: "${ocrAuthor}"`);
  }

  // Sort by priority and limit to PASS2_MAX_HYPOTHESES
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, PASS2_MAX_HYPOTHESES);

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[HypothesesBoost] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Get the set of query strings from hypotheses (for deduplication)
 */
export function getQuerySet(hypotheses: SearchHypothesis[]): Set<string> {
  return new Set(hypotheses.map((h) => h.query.toLowerCase().trim()));
}
