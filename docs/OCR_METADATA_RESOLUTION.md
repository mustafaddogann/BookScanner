# OCR & Metadata Resolution Guide

This document describes the patterns, filters, and algorithms used to accurately match books from OCR text to metadata providers (Open Library, Google Books).

## Table of Contents
- [Overview](#overview)
- [Common OCR Challenges](#common-ocr-challenges)
- [Generic Filters](#generic-filters)
- [Hypothesis Generation](#hypothesis-generation)
- [Scoring & Thresholds](#scoring--thresholds)
- [Test Cases](#test-cases)
- [Debugging](#debugging)

---

## Overview

The metadata resolution pipeline:
1. **OCR** extracts text from book spine crops
2. **Evidence Merger** combines text from multiple crops, filters noise
3. **Hypothesis Generator** creates search queries from evidence
4. **Metadata Providers** search Open Library / Google Books
5. **Scoring** ranks candidates using token overlap (F1 score)
6. **Decision Gate** accepts/rejects/suggests based on confidence

---

## Common OCR Challenges

### 1. Multi-line Titles
Book titles often split across multiple lines on spines:
```
PELICAN     →  "The Pelican Brief"
BRIEF

STRANGERS   →  "Strangers She Knows"
SHE
KNOWS
```

### 2. Marketing Badges
NYT Bestseller badges are common and pollute searches:
```
NEW YORK TIMES BESTSELLING AUTHOR
#1 BESTSELLER
NATIONAL BESTSELLER
```

### 3. Manufacturing Notices
Printing info appears on spines/back covers:
```
PRINTED IN USA
MADE IN CHINA
```
OCR often captures fragments: `TED IN USA` (from "PRINTED IN USA")

### 4. OCR Typos
Character recognition errors:
```
STRAIGHI  →  STRAIGHT (I/T confusion)
CAVE      →  FAYE (C/F confusion)
BESTSELING → BESTSELLING (missing L)
NEW-YORK  →  NEW YORK (hyphen insertion)
```

### 5. Author Name Confusion
Marketing text mistaken for author:
```
"NEW YORK TIMES" detected as person name
"TED IN USA" detected as person name
```

---

## Generic Filters

### Marketing Phrase Filter
**File:** `src/services/evidenceNormalization.ts`

Filters lines containing:
```javascript
const MARKETING_PHRASES = [
  'new york times bestseller',
  'new york times',
  'new-york times',      // OCR hyphen variant
  'newyork times',       // OCR no-space variant
  'nyt bestseller',
  '#1 bestseller',
  'number one bestseller',
  'international bestseller',
  'bestselling author',
  'bestseling author',   // OCR typo
  'national bestseller',
  'bestseller',
  'bestseling',          // OCR typo
  'a novel',
  'the novel',
  'now a major motion picture',
  // ... more
];
```

### Manufacturing Noise Filter
**File:** `src/services/evidenceNormalization.ts`

Filters lines matching:
```javascript
const NOISE_PATTERNS = [
  /\bin\s+usa\b/i,
  /\bin\s+china\b/i,
  /\bin\s+uk\b/i,
  /\bprinted\s+in\b/i,
  /\bmade\s+in\b/i,
  /\bmanufactured\s+in\b/i,
];
```

### Organization Name Filter
**File:** `src/services/titleAuthorExtraction.ts`

Prevents org names from being detected as authors:
```javascript
const ORG_MARKERS = ['press', 'publishing', 'books', 'house', ...];

// Also checks for patterns like:
/\bin\s+(usa|china|uk)\b/i  // "TED IN USA" is not a person
```

### Person Name Validation
**File:** `src/services/evidenceNormalization.ts`

`looksLikePersonName()` rejects:
- Lines starting with articles (THE, A, AN)
- Genre words (FICTION, MYSTERY)
- Marketing phrases
- Organization patterns
- Manufacturing notices

---

## Hypothesis Generation

### Priority Order
**File:** `src/services/queryHypotheses.ts`

| Priority | Type | Example |
|----------|------|---------|
| 0 | ISBN | `9780385339704` |
| 10 | title + author | `"PELICAN BRIEF JOHN GRISHAM"` |
| 14 | 3-line combo | `"STRANGERS SHE KNOWS"` |
| 15 | 2-line combo (single words) | `"PELICAN BRIEF"` |
| 20 | title only (multi-word) | `"THE SHINING"` |
| 25 | title only (single word) | `"PELICAN"` |
| 30 | stripped variant | `"SHINING STEPHEN KING"` (no "THE") |
| 32 | last-word variant | `"DARKNESS KELLERMAN"` |
| 33+ | adjacent combos | Various line combinations |

### Adjacent Line Combos
Combines consecutive lines that might form a title:

**2-line combos:**
```
Lines: ["PELICAN", "BRIEF", "TED IN USA"]
Generates: "PELICAN BRIEF" (priority 15 - both single words)
```

**3-line combos:**
```
Lines: ["STRANGERS", "SHE", "KNOWS", "CHRISTINA DODD"]
Generates: "STRANGERS SHE KNOWS" (priority 14)
```

### Last-Word Variant
Handles OCR errors in middle of title:
```
Title: "STRAIGHI INTO DARKNESS" (error in STRAIGHI)
Author: "CAVE KELLERMAN"
Generates: "DARKNESS KELLERMAN" → finds correct book
```

### Article Stripping
Removes leading articles for search variants:
```
"THE SHINING" → "SHINING"
"A BRIEF HISTORY" → "BRIEF HISTORY"
```

---

## Scoring & Thresholds

### Token Matching
**File:** `src/services/candidateScoring.ts`

Uses F1 score with fuzzy Levenshtein matching:
```
Precision = matched_tokens / evidence_tokens
Recall = matched_tokens / api_title_tokens
F1 = 2 * P * R / (P + R)
```

### Fuzzy Match Threshold
**File:** `src/services/tokenSetFuzzyScoring.ts`

```javascript
FUZZY_MATCH_THRESHOLD = 0.84  // 84% similarity required
```

Examples:
- `STRAIGHI` vs `STRAIGHT`: 87.5% similarity ✓
- `BESTSELING` vs `BESTSELLING`: 90% similarity ✓

### Decision Thresholds
**File:** `src/config/metadataResolutionConfig.ts`

| Threshold | Value | Decision |
|-----------|-------|----------|
| ACCEPT_HIGH | 0.85 | Auto-accept, catalog |
| ACCEPT_MEDIUM | 0.70 | Accept with gap check |
| SUGGESTED | 0.55 | Suggest to user |
| SUGGESTED_WEAK | 0.45 | Weak suggestion (UI only) |
| Below 0.45 | - | Reject |

### Penalties
| Penalty | Amount | Trigger |
|---------|--------|---------|
| GENERIC_TITLE | 0.15 | Single generic word title without author |
| MISSING_AUTHOR | 0.40 | Candidate has no author information |

The MISSING_AUTHOR penalty ensures editions with known authors are preferred over those without (e.g., "The Pelican Brief" by John Grisham beats "THE PELICAN BRIEF" by unknown).

### Title-Only Mode
When no author is detected (authorScore < 0.30):
- `titleScore >= 0.92` with anti-ambiguity signals → **accept_medium**
- `titleScore >= 0.72` → **suggested** (lowered from 0.78 for OCR tolerance)
- `titleScore >= 0.45` → **suggested_weak**
- Requires `titleTokenCount >= 2`

**Precision Adjustment:** Author-matched evidence tokens are excluded from title precision calculation, preventing author tokens like "KELLERMAN" from diluting title scores.

---

## Test Cases

### Case 1: The Pelican Brief
```
OCR Lines:
- PELICAN
- BRIEF
- TED IN USA
- 21404-

Expected:
- "TED IN USA" filtered (manufacturing noise)
- Adjacent combo: "PELICAN BRIEF" (priority 15)
- Match: "The Pelican Brief" by John Grisham
```

### Case 2: Straight into Darkness
```
OCR Lines:
- ISIO
- CAVE KELLERMAN
- STRAIGHI INTO
- DARKNESS

Expected:
- Author detected: "CAVE KELLERMAN"
- Title reconstructed: "STRAIGHI INTO DARKNESS"
- Last-word variant: "DARKNESS KELLERMAN"
- Fuzzy match: STRAIGHI ≈ STRAIGHT (87.5%)
- Match: "Straight into Darkness" by Faye Kellerman
```

### Case 3: Strangers She Knows
```
OCR Lines:
- HON
- STRANGERS
- SHE
- KNOWS
- CHRISTINA DODD
- NEW-YORK TIMES BESTSELING AUTHOR-

Expected:
- Marketing filtered: "NEW-YORK TIMES BESTSELING AUTHOR-"
- Author detected: "CHRISTINA DODD"
- 3-line combo: "STRANGERS SHE KNOWS" (priority 14)
- Match: "Strangers She Knows" by Christina Dodd
```

### Case 4: The Buried (Lisa Childs)
```
OCR Lines:
- ZEBRA
- NEW FORK TIMES BESTSELLER
- LISA CHILDS
- THE
- BURIED

Expected:
- Marketing filtered: "NEW FORK TIMES BESTSELLER"
- Author detected: "LISA CHILDS"
- Title: "THE BURIED" (multi-line reconstruction)
- Stripped variant: "BURIED LISA CHILDS"
- Match: "The Buried" by Lisa Childs
```

---

## Debugging

### Console Logs (Always-On)

**Hypothesis Generation:**
```
[Hypotheses] titleLikeLines: ...
[Hypotheses] advancedExtraction.title: "..." (conf=0.85)
[Hypotheses] advancedExtraction.author: "..." (conf=0.90)
[Hypotheses] bestTitle: "...", bestAuthor: "..."
[Hypotheses] Adding adjacent lines combo: "..." (priority=15)
[Hypotheses] Adding last-word variant: "..."
```

**Open Library Search:**
```
[OpenLibrary] Search doc: title="..." author_name=["..."]
[OpenLibrary] hypothesis=1/5 type=title_author query="..." results=3
[OpenLibrary]   top result: "The Pelican Brief" by John Grisham
```

**Scoring:**
```
[ScoringDebug] candidate: { title, authors, evidenceTokens, overlapCount, ... }
[MetadataResolution] hypotheses_count=5 shapes=[title_author,title_only,...]
```

**Evidence Merger:**
```
[EvidenceMerger] Merged lines: "PELICAN", "BRIEF"
[EvidenceMerger] Title hints: PELICAN BRIEF
[EvidenceMerger] Filtered out bad author candidate: "TED IN USA"
```

### Running Tests
```bash
# All hypothesis tests
npm test -- --testPathPattern="queryHypotheses"

# Specific test cases
npm test -- --testPathPattern="queryHypotheses" --testNamePattern="PELICAN"
npm test -- --testPathPattern="queryHypotheses" --testNamePattern="DARKNESS"

# Evidence normalization tests
npm test -- --testPathPattern="evidenceNormalization"

# Title/author extraction tests
npm test -- --testPathPattern="titleAuthorExtraction"
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/services/queryHypotheses.ts` | Generates search hypotheses |
| `src/services/evidenceNormalization.ts` | Filters noise, tokenizes evidence |
| `src/services/titleAuthorExtraction.ts` | Detects title/author from lines |
| `src/services/candidateScoring.ts` | Scores and ranks candidates |
| `src/services/tokenSetFuzzyScoring.ts` | Fuzzy Levenshtein matching |
| `src/services/openLibraryProvider.ts` | Open Library API integration |
| `src/services/googleBooksProvider.ts` | Google Books API fallback |
| `src/services/metadataResolutionOrchestrator.ts` | Orchestrates resolution flow |
| `src/config/metadataResolutionConfig.ts` | Thresholds and configuration |

---

## Author Token Exclusion (Title Precision Fix)

**File:** `src/services/candidateScoring.ts`

When computing `titleScore` for TITLE_ONLY mode, the precision calculation now excludes evidence tokens that matched the author. This prevents author tokens in the evidence (e.g., "KELLERMAN") from diluting title precision.

**Example:**
```
Evidence: [ISIO, CAVE, KELLERMAN, STRAIGHI, INTO, DARKNESS] = 6 tokens
API title: "Straight into Darkness"
API author: "Faye Kellerman"

Without adjustment:
  - titlePrecision = 3/6 = 0.50 (penalized by CAVE, KELLERMAN, ISIO)

With adjustment:
  - Author matched: 1 (KELLERMAN)
  - Adjusted evidence count: 6 - 1 = 5
  - titlePrecision = 3/5 = 0.60
  - titleScore = F1(0.60, 1.00) = 0.75
```

---

## Future Improvements

1. **~~Author token exclusion~~**: ✅ Implemented - evidence tokens matching author are excluded from title precision
2. **Short noise token filtering**: Filter 3-4 char tokens that don't match any candidate (e.g., "ISIO")
3. **Contextual noise detection**: Use ML to identify noise vs content
4. **Multi-hypothesis parallel search**: Search multiple hypotheses simultaneously
5. **Confidence calibration**: Tune thresholds based on real-world accuracy data
6. **ISBN barcode scanning**: Use camera to scan ISBN barcodes for guaranteed matches
