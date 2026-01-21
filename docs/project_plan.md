# BookScanner Project Plan

This document consolidates the current implementation state, architecture overview, and roadmap for extracting structured book spine metadata (title, author, publisher, edition, ISBN) with higher accuracy.

**Related Documentation:**
- [docs/pipeline.md](./pipeline.md) - Detailed pipeline stage documentation
- [docs/gates.md](./gates.md) - Gates 0-5 checklist (ML training through end-to-end)
- [docs/build.md](./build.md) - Build and environment setup

---

## Table of Contents

1. [Current State](#current-state)
2. [Architecture Overview](#architecture-overview)
3. [Gates 7-10: Structured Metadata Extraction](#gates-7-10-structured-metadata-extraction)
   - [Gate 7: Book Candidate Grouping + Evidence Merge](#gate-7-book-candidate-grouping--evidence-merge)
   - [Gate 8: Field Extraction with Ranked Candidates](#gate-8-field-extraction-with-ranked-candidates)
   - [Gate 9: Resolver (External Lookup)](#gate-9-resolver-external-lookup)
   - [Gate 10: Corrections Memory](#gate-10-corrections-memory)
4. [Execution Strategy](#execution-strategy)
5. [Appendix: Type Definitions](#appendix-type-definitions)

---

## Current State

### What's Working (End-to-End on iOS)

The BookScanner app has a complete pipeline from image capture through OCR results display:

| Stage | Status | Platform Support |
|-------|--------|------------------|
| Camera capture | Working | iOS, Android |
| YOLOv8 OBB detection | Working | iOS, Android |
| Coordinate mapping | Working | iOS, Android |
| SVG overlay | Working | iOS, Android |
| Native rectification | Working | iOS only (CoreImage) |
| OCR | Working | iOS (Vision), Android (ML Kit) |
| Results UI | Working | iOS, Android |
| Book Candidate Grouping (Gate 7) | Working | iOS, Android |
| Metadata Resolution (feature-flagged) | Working | iOS, Android |

### Platform-Specific Implementation Details

**iOS Rectification:**
- Uses CoreImage `CIPerspectiveCorrection` filter
- Max output dimension capped at 2048px
- Produces upright, deskewed crop images

**Android Rectification:**
- Placeholder implementation returning `skipped`
- No perspective correction available yet
- Crops tab shows "Rectification Unavailable"

**OCR Implementation:**
- iOS: Apple Vision `VNRecognizeTextRequest` with accurate recognition level
- Android: ML Kit text recognition
- Both platforms try 4 rotations (0°, 90°, 180°, 270°) and select best by confidence/alnum ratio/char count

### Current Data Flow

```
SessionMeta (Zustand store - single source of truth)
├── frameGeo: SerializedFrameGeo
├── imageDimensions: { width, height }
├── normalizedImagePath: string
├── displayImagePath: string
├── rectificationResults: DetectionRectifyInfo[]
├── rectificationSummary: { total, succeeded, skipped }
├── ocrResultsByCropIndex: Record<number, OCRResult>
├── ocrSummary: OCRSummary
├── userEdits: Record<number, { title?, author? }>
├── bookCandidates: BookCandidate[]           # Gate 7
├── bookCandidatesSummary: BookCandidatesSummary
├── evidenceSummary?: EvidenceSummary         # Metadata Resolution (feature-flagged)
├── metadataResolution?: MetadataResolutionState
└── metadataQueuedForOffline?: boolean
```

### Existing Services

| Service | Location | Purpose |
|---------|----------|---------|
| `pipelineService.ts` | `src/services/` | Orchestrates full pipeline |
| `inferenceService.ts` | `src/services/` | TFLite model inference |
| `rectificationService.ts` | `src/services/` | Native module bridge for rectification |
| `textRecognitionService.ts` | `src/services/` | Native OCR bridge |
| `ocrPostProcessingService.ts` | `src/services/` | Title/author heuristics, noise filtering |
| `bookCandidateGrouper.ts` | `src/services/` | Conservative grouping: only merge on high IoU or OCR-confirmed split-detection |
| `spineEvidenceMerger.ts` | `src/services/` | Merge OCR from multiple crops |

### Metadata Resolution Services (Feature-Flagged)

| Service | Location | Purpose |
|---------|----------|---------|
| `evidenceQualityService.ts` | `src/services/` | Classify evidence tier per crop |
| `searchCandidateService.ts` | `src/services/` | Generate search candidates from evidence |
| `metadataResolverService.ts` | `src/services/` | Score and rank matches |
| `matchVerificationService.ts` | `src/services/` | Verify matches, generate flags |
| `acceptanceDecisionService.ts` | `src/services/` | Make acceptance decisions |
| `metadataResolutionOrchestrator.ts` | `src/services/` | Orchestrate full resolution pipeline |
| `metadataLookupProvider.ts` | `src/services/` | Provider interface for metadata lookup |
| `metadataLookupProviderFactory.ts` | `src/services/` | Factory for metadata lookup providers |
| `offlineResolutionQueue.ts` | `src/services/` | Queue for offline retry |
| `stringSimilarity.ts` | `src/services/` | Fuzzy string matching utilities |
| `isbnUtils.ts` | `src/services/` | ISBN parsing and validation |

**Feature Flags** (in `src/config/debug.ts`):
- `METADATA_RESOLUTION_ENABLED` - Enable metadata resolution (default: false)
- `METADATA_OFFLINE_QUEUE_ENABLED` - Enable offline queue (default: false)
- `METADATA_VERBOSE_DEBUG` - Verbose logging (default: false)

### Existing OCR Post-Processing

The `ocrPostProcessingService.ts` already provides:
- Line normalization (trim, collapse whitespace)
- Noise filtering (ISBN patterns, URLs, prices, barcodes)
- Title/author candidate extraction with heuristics
- Session-level aggregation
- User edit support

### Test Coverage

- Jest environment configured and working
- Tests pass with `--watchman=false` flag
- TypeScript compiles without errors
- Test files: `src/services/__tests__/*.test.ts`, `src/utils/__tests__/*.test.ts`

---

## Architecture Overview

### Pipeline Stages (Current + Planned)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EXISTING PIPELINE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Image Capture ──▶ META ──▶ LETTERBOX ──▶ INFERENCE ──▶ POSTPROCESS │
│                                                   │                 │
│                                                   ▼                 │
│                              OVERLAY-PREP ◀── RECTIFICATION         │
│                                                   │                 │
│                                                   ▼                 │
│                                                  OCR                │
│                                                   │                 │
└───────────────────────────────────────────────────┼─────────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NEW GATES (7-10)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ GATE 7: GROUPING + MERGE                                │       │
│  │ • Cluster detections into book candidates               │       │
│  │ • Merge OCR evidence from multiple crops                │       │
│  │ • Output: SessionMeta.bookCandidates[]                  │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ GATE 8: FIELD EXTRACTION                                │       │
│  │ • Extract title/author/isbn/publisher/edition           │       │
│  │ • Ranked candidate arrays per field                     │       │
│  │ • Output: BookCandidate.extractedFields                 │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ GATE 9: RESOLVER (feature-flagged OFF)                  │       │
│  │ • Online lookup: Open Library, Google Books             │       │
│  │ • Correct OCR errors, fill missing fields               │       │
│  │ • Output: BookCandidate.resolvedMetadata                │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ GATE 10: CORRECTIONS MEMORY                             │       │
│  │ • Persist user edits keyed by content hash / ISBN       │       │
│  │ • Auto-apply on future scans                            │       │
│  │ • Output: correctionsStore in MMKV                      │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Where New Gates Plug In

New gates integrate into the existing pipeline after OCR:

```typescript
// In pipelineService.ts, after OCR stage:

// Gate 7: Group detections into book candidates
const bookCandidates = bookCandidateGrouper.group(detections, rectResults);
const mergedCandidates = spineEvidenceMerger.merge(bookCandidates, ocrResults);

// Gate 8: Extract structured fields
const extractedCandidates = spineFieldExtractor.extract(mergedCandidates);

// Gate 9: Resolve via external lookup (feature-flagged)
const resolvedCandidates = METADATA_LOOKUP_ENABLED
  ? await bookResolverService.resolve(extractedCandidates)
  : extractedCandidates;

// Gate 10: Apply corrections memory
const finalCandidates = correctionsMemory.apply(resolvedCandidates);

// Store in SessionMeta
setSessionMeta({
  ...sessionMeta,
  bookCandidates: finalCandidates,
});
```

---

## Gates 7-10: Structured Metadata Extraction

### Gate 7: Book Candidate Grouping + Evidence Merge

**NO external lookup in this gate.**

#### Problem

Currently, each detection/crop is treated as a separate book. In reality, multiple detections may represent the same physical book (overlapping regions, different angles, adjacent spine segments). This leads to:
- Duplicate entries in results
- Fragmented OCR text that could be merged for better accuracy
- Confusing UX with N crops instead of M books (where M < N)

#### Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/services/bookCandidateGrouper.ts` | Service | Cluster detections into book candidates |
| `src/services/spineEvidenceMerger.ts` | Service | Merge OCR from top K crops per candidate |
| `src/types/index.ts` | Types | `BookCandidate`, `MergedEvidence`, `EvidenceLine` |
| `src/store/useAppStore.ts` | Store | Add `bookCandidates` to `SessionMeta` |
| `src/screens/ResultsScreen.tsx` | UI | Add "Books" tab showing grouped candidates |

#### Data Contracts

```typescript
// src/types/index.ts

/**
 * A single line of evidence from OCR
 */
export interface EvidenceLine {
  text: string;
  confidence: number;
  sourceCropIndex: number;
  sourceRotation: number;
  bbox?: OCRBoundingBox;
}

/**
 * Merged evidence from multiple crops for a single book candidate
 */
export interface MergedEvidence {
  /** De-duplicated lines with source tracking */
  lines: EvidenceLine[];
  /** Concatenated full text (for display) */
  fullText: string;
  /** Crop indices contributing to this evidence */
  contributingCrops: number[];
  /** Average confidence across all lines */
  avgConfidence: number;
}

/**
 * A book candidate representing one physical book on the shelf
 */
export interface BookCandidate {
  /** Unique ID for this candidate within the session */
  candidateId: string;
  /** Detection indices that belong to this candidate */
  detectionIndices: number[];
  /** Crop indices for this candidate (subset of detections with successful rectification) */
  cropIndices: number[];
  /** Merged OCR evidence */
  evidence: MergedEvidence;
  /** Position on shelf (0 = leftmost) */
  shelfPosition: number;
  /** Centroid in image coordinates */
  centroid: { x: number; y: number };
  /** Extracted fields (populated by Gate 8) */
  extractedFields?: ExtractedFields;
  /** Resolved metadata (populated by Gate 9) */
  resolvedMetadata?: ResolvedMetadata;
}
```

#### Algorithm: bookCandidateGrouper (CONSERVATIVE)

The grouper uses a **conservative-by-default** approach to avoid incorrectly merging unrelated spines.

```typescript
// CONSERVATIVE THRESHOLDS
const IOU_MERGE_THRESHOLD = 0.50;           // Minimum IoU to merge as duplicates
const SPLIT_ANGLE_THRESHOLD_RAD = 0.175;    // ~10 degrees max angle difference
const SPLIT_CENTER_DIST_RATIO = 0.15;       // Center proximity as % of min dimension
const SPLIT_OCR_SIMILARITY_THRESHOLD = 0.75; // Minimum OCR text similarity
const MAX_CROPS_PER_CANDIDATE = 3;          // Safety cap - triggers fallback if exceeded

function group(
  detections: OBBDetection[],
  rectificationResults: DetectionRectifyInfo[],
  ocrResultsByCropIndex?: Record<number, OCRResult>
): BookCandidate[] {
  // 1. Start with each detection as its own candidate (conservative default)

  // 2. Only merge under STRICT conditions:
  //    Path A - High IoU (>= 0.50): Duplicate detections that heavily overlap
  //    Path B - Split-detection: ALL conditions must be met:
  //      - Angle diff <= 10°
  //      - Center distance <= 15% of min dimension
  //      - OCR text similarity >= 0.75 (REQUIRED - no OCR = no merge)

  // 3. Safety cap: If any candidate would have > 3 crops after merging,
  //    fall back to 1:1 mapping (no merges at all)

  // 4. For each cluster:
  //    - Select representative detection (highest score, largest area tiebreak)
  //    - Compute centroid

  // 5. Sort candidates left-to-right by centroid.x

  // 6. Return sorted BookCandidate[] with debug assignments
}
```

**Key Design Decisions:**
- Without OCR confirmation, split-detection merges are blocked entirely
- High IoU merges (true duplicates) work without OCR
- Safety cap prevents runaway merging (e.g., 10 detections → 1 candidate)

#### Algorithm: spineEvidenceMerger

```typescript
const TOP_K_CROPS = 3; // Select best 3 crops per candidate

function merge(
  candidate: BookCandidate,
  ocrResults: Record<number, OCRResult>,
  rectResults: DetectionRectifyInfo[]
): MergedEvidence {
  // 1. Score each crop by OCR quality:
  //    score = avgConfidence * alnumRatio * sqrt(charCount)

  // 2. Select top K crops

  // 3. Collect all lines from selected crops

  // 4. De-duplicate lines:
  //    - Normalize: lowercase, remove punctuation
  //    - Fuzzy match with Levenshtein distance threshold
  //    - Keep highest-confidence version of duplicates

  // 5. Order lines by vertical position (if bbox available)
  //    or by source crop confidence

  // 6. Return MergedEvidence
}
```

#### UI Changes

Add a third tab to ResultsScreen: "Books"

```
┌──────────────────────────────────────────┐
│  [Overlay]   [Crops]   [Books]           │
├──────────────────────────────────────────┤
│                                          │
│  ┌────────────────────────────────┐     │
│  │ Book 1                         │     │
│  │ ┌──────┐ ┌──────┐ ┌──────┐    │     │
│  │ │crop 0│ │crop 1│ │crop 2│    │     │
│  │ └──────┘ └──────┘ └──────┘    │     │
│  │ "The Great Gatsby"            │     │
│  │ Confidence: 94%               │     │
│  └────────────────────────────────┘     │
│                                          │
│  ┌────────────────────────────────┐     │
│  │ Book 2                         │     │
│  │ ┌──────┐                       │     │
│  │ │crop 3│                       │     │
│  │ └──────┘                       │     │
│  │ "To Kill a Mockingbird"       │     │
│  │ Confidence: 87%               │     │
│  └────────────────────────────────┘     │
│                                          │
└──────────────────────────────────────────┘
```

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/bookCandidateGrouper.test.ts` | Conservative clustering, merge paths, safety cap |
| `src/services/__tests__/spineEvidenceMerger.test.ts` | Merging, deduplication |

```typescript
// Conservative grouping test cases (19 tests)
describe('bookCandidateGrouper - Conservative Algorithm', () => {
  // No merge by default
  it('should NOT merge 10 detections that are far apart', () => {});
  it('should NOT merge detections with different angles even if close', () => {});
  it('should NOT merge nearby detections without OCR similarity', () => {});

  // Merge duplicates (high IoU path)
  it('should merge two nearly identical detections with high IoU', () => {});
  it('should merge overlapping detections with >= 50% IoU', () => {});

  // Split merge with OCR similarity
  it('should merge split-detection when OCR confirms same text', () => {});

  // No split merge without OCR similarity
  it('should NOT merge split-detection when OCR text is different', () => {});
  it('should NOT merge when OCR similarity is below threshold (0.75)', () => {});

  // Safety cap fallback
  it('should trigger safety fallback when a candidate would have > 3 crops', () => {});
  it('should NOT trigger safety fallback when clusters are small', () => {});

  // Ordering, representative selection, crop mapping, debug assignments
  it('should order candidates left-to-right by centroid X', () => {});
  it('should select detection with highest score as representative', () => {});
  it('should include config in debug assignments', () => {});
  it('should track merge records when merges occur', () => {});
  it('should clear merge records when safety fallback triggers', () => {});
});

describe('spineEvidenceMerger', () => {
  it('selects top K crops by OCR quality', () => {});
  it('deduplicates identical lines', () => {});
  it('deduplicates fuzzy-matching lines', () => {});
  it('preserves highest-confidence version', () => {});
  it('tracks source crop for each line', () => {});
});
```

#### Validation Commands

```bash
# Run unit tests
npx jest src/services/__tests__/bookCandidateGrouper.test.ts --watchman=false
npx jest src/services/__tests__/spineEvidenceMerger.test.ts --watchman=false

# TypeScript check
npx tsc --noEmit

# Manual validation on device
# 1. Scan a shelf with 5+ books
# 2. Verify "Books" tab shows fewer candidates than "Crops" tab
# 3. Verify each book candidate shows contributing crops
# 4. Verify merged text is readable and complete
```

#### Acceptance Criteria

- [x] Conservative grouping: 10 separate spines → 10 candidates (no incorrect merging)
- [x] High IoU duplicates (≥ 0.50) merge correctly
- [x] Split-detection merges only with OCR similarity ≥ 0.75
- [x] Safety cap: clusters > 3 crops trigger fallback to 1:1
- [x] Book candidates are in stable left-to-right order
- [x] Debug artifact `grouping_assignments.json` written (when enabled)
- [x] 19 comprehensive unit tests passing
- [ ] Merged evidence contains de-duplicated lines
- [ ] Each line tracks source crop index and rotation
- [ ] UI shows "Books" view with candidate details

#### Debug Artifacts

When `DEBUG_ARTIFACTS_ENABLED` is true, the grouper writes `grouping_assignments.json`:

```json
{
  "candidates": [
    { "candidateId": "session_book_0", "cropIndices": [0], "detectionIndices": [0] },
    { "candidateId": "session_book_1", "cropIndices": [1], "detectionIndices": [1] }
  ],
  "merges": [],
  "safetyFallbackTriggered": false,
  "config": {
    "iouMergeThreshold": 0.5,
    "splitAngleThresholdDeg": 10.03,
    "splitCenterDistRatio": 0.15,
    "splitOcrSimilarityThreshold": 0.75,
    "maxCropsPerCandidate": 3
  }
}
```

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Over-grouping (merging different books) | **FIXED**: Conservative algorithm requires high IoU or OCR confirmation |
| Under-grouping (same book as multiple candidates) | Log grouping decisions in debug artifacts; add manual merge in UI |
| Performance with many detections | O(n²) clustering is fine for n<100; optimize if needed |

---

### Gate 8: Field Extraction with Ranked Candidates

**NO external lookup in this gate.**

#### Problem

Current OCR post-processing produces single `titleCandidate` and `authorCandidate` strings with simple heuristics. This misses:
- ISBN detection and validation
- Publisher/edition extraction
- Handling complex patterns like "Author • Title" or "Title - Author"
- Confidence ranking for ambiguous cases

#### Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/services/spineFieldExtractor.ts` | Service | Extract and rank field candidates |
| `src/services/isbnValidator.ts` | Service | ISBN-10/13 parsing and checksum validation |
| `src/types/index.ts` | Types | `ExtractedFields`, `FieldCandidate` |
| `src/screens/ResultsScreen.tsx` | UI | Show chosen fields + debug toggle for alternatives |

#### Data Contracts

```typescript
// src/types/index.ts

/**
 * A single candidate for a field value
 */
export interface FieldCandidate {
  value: string;
  confidence: number;
  source: 'ocr' | 'pattern' | 'inferred';
  /** Which evidence lines contributed */
  sourceLines: number[];
}

/**
 * Extracted fields for a book candidate
 */
export interface ExtractedFields {
  /** Ranked title candidates (best first) */
  titleCandidates: FieldCandidate[];
  /** Ranked author candidates (best first) */
  authorCandidates: FieldCandidate[];
  /** ISBN if detected (validated) */
  isbn: FieldCandidate | null;
  /** Publisher if detected */
  publisherCandidates: FieldCandidate[];
  /** Edition if detected */
  editionCandidates: FieldCandidate[];
  /** Chosen values (best candidate for each) */
  chosen: {
    title: string | null;
    author: string | null;
    isbn: string | null;
    publisher: string | null;
    edition: string | null;
  };
}
```

#### Algorithm: spineFieldExtractor

```typescript
function extract(candidate: BookCandidate): ExtractedFields {
  const lines = candidate.evidence.lines;

  // 1. ISBN Detection
  //    - Regex: /(?:ISBN[-: ]?)?(\d{10}|\d{13}|\d[\d-]{11,16}\d)/i
  //    - OCR-tolerant normalization: 'O'→'0', 'l'→'1', 'I'→'1', 'S'→'5'
  //    - Validate checksum (ISBN-10 mod 11, ISBN-13 mod 10)

  // 2. Split Detection Patterns
  //    - "Author • Title" → split on •, ·, |
  //    - "Title - Author" → split on " - ", " – "
  //    - "by Author" → extract after "by "
  //    - "Title\nAuthor" → use line breaks

  // 3. Title/Author Heuristics (improved)
  //    - Longest capitalized phrase → likely title
  //    - 2-3 word phrase with capital initials → likely author name
  //    - Avoid common noise: "HARDCOVER", "PAPERBACK", year patterns

  // 4. Publisher Detection
  //    - Known publisher database (Penguin, HarperCollins, etc.)
  //    - Pattern: "Published by X", "X Publishing"

  // 5. Edition Detection
  //    - Pattern: "1st Edition", "Revised", "Second Edition"
  //    - Year + "Edition" pattern

  // 6. Rank candidates by confidence

  // 7. Choose best for each field
}
```

#### ISBN Validator

```typescript
// src/services/isbnValidator.ts

export interface IsbnValidationResult {
  valid: boolean;
  normalized: string;  // Digits only
  type: 'isbn10' | 'isbn13' | null;
  original: string;
}

export function validateIsbn(input: string): IsbnValidationResult {
  // 1. OCR-tolerant normalization
  const normalized = input
    .replace(/[Oo]/g, '0')
    .replace(/[lIi]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[-\s]/g, '');

  // 2. Extract digits (and X for ISBN-10)
  const digits = normalized.replace(/[^0-9Xx]/g, '');

  // 3. Validate length and checksum
  if (digits.length === 10) {
    return { valid: validateIsbn10(digits), normalized: digits, type: 'isbn10', original: input };
  }
  if (digits.length === 13) {
    return { valid: validateIsbn13(digits), normalized: digits, type: 'isbn13', original: input };
  }

  return { valid: false, normalized: '', type: null, original: input };
}

function validateIsbn10(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * (10 - i);
  }
  const check = digits[9].toUpperCase() === 'X' ? 10 : parseInt(digits[9], 10);
  sum += check;
  return sum % 11 === 0;
}

function validateIsbn13(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += parseInt(digits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}
```

#### UI Changes

Update book candidate card to show extracted fields:

```
┌────────────────────────────────────────┐
│ Book 1                          [Edit] │
├────────────────────────────────────────┤
│ Title: The Great Gatsby        (94%)   │
│ Author: F. Scott Fitzgerald    (87%)   │
│ ISBN: 978-0743273565            ✓      │
│ Publisher: Scribner            (72%)   │
│                                        │
│ [Debug: Show alternatives ▼]           │
│ ┌────────────────────────────────────┐ │
│ │ Alternative titles:                │ │
│ │  • "Great Gatsby, The" (82%)       │ │
│ │  • "Gatsby" (45%)                  │ │
│ │ Alternative authors:               │ │
│ │  • "Fitzgerald" (76%)              │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/isbnValidator.test.ts` | ISBN-10/13 validation, OCR normalization |
| `src/services/__tests__/spineFieldExtractor.test.ts` | Pattern splitting, field extraction |

```typescript
// Example test cases
describe('isbnValidator', () => {
  it('validates correct ISBN-10', () => {
    expect(validateIsbn('0-306-40615-2').valid).toBe(true);
  });
  it('validates correct ISBN-13', () => {
    expect(validateIsbn('978-0-306-40615-7').valid).toBe(true);
  });
  it('rejects invalid checksum', () => {
    expect(validateIsbn('978-0-306-40615-0').valid).toBe(false);
  });
  it('handles OCR errors: O→0, l→1', () => {
    expect(validateIsbn('O-3O6-4O6l5-2').valid).toBe(true);
  });
});

describe('spineFieldExtractor', () => {
  it('splits "Harper Lee • Bülbülü Öldürmek"', () => {
    const result = extract(evidenceWithLine('Harper Lee • Bülbülü Öldürmek'));
    expect(result.chosen.author).toBe('Harper Lee');
    expect(result.chosen.title).toBe('Bülbülü Öldürmek');
  });
  it('splits "Title - Author"', () => {});
  it('extracts "by Author" pattern', () => {});
  it('detects and validates ISBN in text', () => {});
});
```

#### Validation Commands

```bash
# Run unit tests
npx jest src/services/__tests__/isbnValidator.test.ts --watchman=false
npx jest src/services/__tests__/spineFieldExtractor.test.ts --watchman=false

# TypeScript check
npx tsc --noEmit

# Manual validation
# 1. Scan books with visible ISBNs
# 2. Verify ISBN detected and shows checkmark
# 3. Scan "Author • Title" format books
# 4. Verify correct split (author not as title)
```

#### Acceptance Criteria

- [ ] ISBN-10 and ISBN-13 validated with checksums
- [ ] OCR-tolerant normalization handles O/0, l/1/I, S/5 confusion
- [ ] "Harper Lee • Bülbülü Öldürmek" correctly splits to author + title
- [ ] "Title - Author" pattern correctly splits
- [ ] Ranked alternatives available under debug toggle
- [ ] Title/author swaps reduced compared to current heuristics

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| False ISBN positives (random numbers) | Require checksum validation |
| Wrong split direction ("Title - Author" vs "Author - Title") | Use capitalization + name patterns to distinguish |
| Non-Latin scripts | Ensure Unicode-safe regex and comparison |

---

### Gate 9: Resolver (External Lookup)

**Feature-flagged OFF by default.**

#### Problem

OCR errors are inevitable (e.g., "To Kil1 a Mockingbird"). External databases can:
- Correct misspellings
- Fill missing fields (publisher, edition, cover image)
- Provide canonical data for display and export

#### Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/services/bookResolverService.ts` | Service | Provider interface + orchestration |
| `src/services/providers/openLibraryProvider.ts` | Provider | Open Library API |
| `src/services/providers/googleBooksProvider.ts` | Provider | Google Books API (optional) |
| `src/services/resolverCache.ts` | Cache | MMKV cache for lookup results |
| `src/types/index.ts` | Types | `ResolvedMetadata`, `LookupProvider` |
| `src/config/featureFlags.ts` | Config | `METADATA_LOOKUP_ENABLED` flag |

#### Data Contracts

```typescript
// src/types/index.ts

/**
 * Metadata resolved from external sources
 */
export interface ResolvedMetadata {
  /** Canonical title from external source */
  title: string;
  /** Canonical authors */
  authors: string[];
  /** Normalized ISBN-13 */
  isbn13: string | null;
  /** Normalized ISBN-10 */
  isbn10: string | null;
  /** Publisher name */
  publisher: string | null;
  /** Publication year */
  publishYear: string | null;
  /** Cover image URL */
  coverUrl: string | null;
  /** Data source */
  source: 'openLibrary' | 'googleBooks';
  /** Source record ID */
  sourceId: string;
  /** Match confidence [0-1] */
  matchConfidence: number;
  /** Was auto-accepted (high confidence) or needs review */
  autoAccepted: boolean;
}

/**
 * Provider interface for external lookups
 */
export interface LookupProvider {
  name: string;
  lookupByIsbn(isbn: string): Promise<ResolvedMetadata | null>;
  search(title: string, author?: string): Promise<ResolvedMetadata[]>;
}
```

#### Algorithm: bookResolverService

```typescript
// src/services/bookResolverService.ts

const AUTO_ACCEPT_CONFIDENCE_GAP = 0.3; // Accept if best > second + 0.3
const MIN_AUTO_ACCEPT_CONFIDENCE = 0.8;

async function resolve(candidate: BookCandidate): Promise<BookCandidate> {
  if (!METADATA_LOOKUP_ENABLED) return candidate;

  const extracted = candidate.extractedFields;
  if (!extracted) return candidate;

  // 1. Check cache first
  const cacheKey = extracted.chosen.isbn ||
    normalizeForCache(extracted.chosen.title, extracted.chosen.author);
  const cached = resolverCache.get(cacheKey);
  if (cached) {
    return { ...candidate, resolvedMetadata: cached };
  }

  // 2. Lookup strategy
  let results: ResolvedMetadata[] = [];

  if (extracted.chosen.isbn) {
    // ISBN lookup (most reliable)
    const result = await provider.lookupByIsbn(extracted.chosen.isbn);
    if (result) results = [result];
  }

  if (results.length === 0 && extracted.chosen.title) {
    // Title+author search fallback
    results = await provider.search(
      extracted.chosen.title,
      extracted.chosen.author || undefined
    );
  }

  if (results.length === 0) return candidate;

  // 3. Score and rank results
  const scored = results.map(r => ({
    ...r,
    matchConfidence: computeMatchScore(extracted, r),
  })).sort((a, b) => b.matchConfidence - a.matchConfidence);

  // 4. Auto-accept logic
  const best = scored[0];
  const second = scored[1];
  const gap = second ? best.matchConfidence - second.matchConfidence : 1.0;

  if (best.matchConfidence >= MIN_AUTO_ACCEPT_CONFIDENCE && gap >= AUTO_ACCEPT_CONFIDENCE_GAP) {
    best.autoAccepted = true;
  } else {
    best.autoAccepted = false;
    // Return top 3 as suggestions
    best.suggestions = scored.slice(1, 3);
  }

  // 5. Cache result
  resolverCache.set(cacheKey, best);

  return { ...candidate, resolvedMetadata: best };
}

function computeMatchScore(extracted: ExtractedFields, resolved: ResolvedMetadata): number {
  // Weighted similarity:
  // - ISBN match: 0.5
  // - Title similarity (Levenshtein): 0.3
  // - Author similarity: 0.2
}
```

#### Open Library Provider

```typescript
// src/services/providers/openLibraryProvider.ts

const BASE_URL = 'https://openlibrary.org';

async function lookupByIsbn(isbn: string): Promise<ResolvedMetadata | null> {
  const url = `${BASE_URL}/isbn/${isbn}.json`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  // Map Open Library response to ResolvedMetadata
}

async function search(title: string, author?: string): Promise<ResolvedMetadata[]> {
  const query = encodeURIComponent(author ? `${title} ${author}` : title);
  const url = `${BASE_URL}/search.json?q=${query}&limit=5`;
  const response = await fetch(url);
  const data = await response.json();

  return data.docs.slice(0, 5).map(mapToResolvedMetadata);
}
```

#### Cache Implementation

```typescript
// src/services/resolverCache.ts

import { storage } from '../store/useAppStore';

const CACHE_PREFIX = 'resolver_cache_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function get(key: string): ResolvedMetadata | null {
  const data = storage.getString(`${CACHE_PREFIX}${key}`);
  if (!data) return null;

  const cached = JSON.parse(data);
  if (Date.now() > cached.expiresAt) {
    storage.delete(`${CACHE_PREFIX}${key}`);
    return null;
  }

  return cached.value;
}

export function set(key: string, value: ResolvedMetadata): void {
  storage.set(`${CACHE_PREFIX}${key}`, JSON.stringify({
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  }));
}
```

#### Feature Flag

```typescript
// src/config/featureFlags.ts

export const METADATA_LOOKUP_ENABLED = false; // OFF by default
```

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/bookResolverService.test.ts` | Scoring, auto-accept logic |
| `src/services/__tests__/openLibraryProvider.test.ts` | API mocking, response mapping |
| `src/services/__tests__/resolverCache.test.ts` | Cache get/set, TTL expiry |

```typescript
// Example test cases
describe('bookResolverService', () => {
  it('auto-accepts high-confidence ISBN match', () => {});
  it('returns suggestions for ambiguous matches', () => {});
  it('uses cache on repeated lookups', () => {});
  it('does nothing when feature flag is off', () => {});
});

describe('openLibraryProvider', () => {
  it('parses ISBN lookup response', () => {});
  it('handles 404 for unknown ISBN', () => {});
  it('parses search response', () => {});
});
```

#### Validation Commands

```bash
# Run unit tests (with mocked fetch)
npx jest src/services/__tests__/bookResolverService.test.ts --watchman=false
npx jest src/services/__tests__/openLibraryProvider.test.ts --watchman=false

# Enable feature flag temporarily for manual testing
# In src/config/featureFlags.ts: METADATA_LOOKUP_ENABLED = true

# Manual validation
# 1. Scan book with ISBN
# 2. Verify canonical title/author from Open Library
# 3. Scan book without ISBN
# 4. Verify search returns relevant suggestions
```

#### Acceptance Criteria

- [ ] ISBN lookup returns canonical metadata from Open Library
- [ ] Search improves title/author accuracy for OCR errors
- [ ] Auto-accept only triggers with sufficient confidence gap
- [ ] Ambiguous cases return top 3 suggestions for user selection
- [ ] Cache prevents repeated API calls for same ISBN/title
- [ ] Feature flag OFF prevents any network calls

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limits | Implement cache; batch requests where possible |
| Wrong matches for common titles | Require confidence gap; show suggestions |
| Network failures | Graceful degradation; use extracted fields as fallback |
| Privacy concerns | Feature flag OFF by default; document data sent |

---

### Gate 10: Corrections Memory

**Highest long-term leverage.**

#### Problem

Users repeatedly scan the same books. Without memory:
- Same OCR errors appear repeatedly
- User must correct the same book every time
- No learning from corrections

#### Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/services/correctionsMemory.ts` | Service | Store and apply corrections |
| `src/store/useCorrectionsStore.ts` | Store | MMKV-backed corrections storage |
| `src/types/index.ts` | Types | `Correction`, `CorrectionKey` |
| `src/screens/ResultsScreen.tsx` | UI | "Edited" indicator, revert option |

#### Data Contracts

```typescript
// src/types/index.ts

/**
 * A user correction for a book
 */
export interface Correction {
  /** Hash of original content (for matching) */
  contentHash: string;
  /** ISBN if available (preferred key) */
  isbn: string | null;
  /** Corrected values */
  correctedTitle: string | null;
  correctedAuthor: string | null;
  /** Original values (for revert) */
  originalTitle: string | null;
  originalAuthor: string | null;
  /** Timestamp of correction */
  createdAt: string;
  /** Number of times auto-applied */
  applyCount: number;
}

/**
 * Key generation for corrections lookup
 */
export type CorrectionKey = string; // ISBN or content hash
```

#### Algorithm: correctionsMemory

```typescript
// src/services/correctionsMemory.ts

import { useCorrectionsStore } from '../store/useCorrectionsStore';

/**
 * Generate stable hash from merged evidence lines
 */
function generateContentHash(evidence: MergedEvidence): string {
  // Normalize: lowercase, sort lines, remove punctuation
  const normalized = evidence.lines
    .map(l => l.text.toLowerCase().replace(/[^\w\s]/g, '').trim())
    .filter(t => t.length > 3)
    .sort()
    .join('|');

  // Simple hash (could use more robust hashing)
  return btoa(normalized).slice(0, 32);
}

/**
 * Find matching correction for a candidate
 */
function findCorrection(candidate: BookCandidate): Correction | null {
  const store = useCorrectionsStore.getState();

  // 1. Try ISBN match first (most reliable)
  if (candidate.extractedFields?.chosen.isbn) {
    const byIsbn = store.corrections[candidate.extractedFields.chosen.isbn];
    if (byIsbn) return byIsbn;
  }

  // 2. Fall back to content hash
  const hash = generateContentHash(candidate.evidence);
  return store.corrections[hash] || null;
}

/**
 * Apply corrections to candidates before UI render
 */
function apply(candidates: BookCandidate[]): BookCandidate[] {
  return candidates.map(candidate => {
    const correction = findCorrection(candidate);
    if (!correction) return candidate;

    // Increment apply count
    saveCorrection({ ...correction, applyCount: correction.applyCount + 1 });

    return {
      ...candidate,
      appliedCorrection: correction,
      extractedFields: {
        ...candidate.extractedFields,
        chosen: {
          ...candidate.extractedFields?.chosen,
          title: correction.correctedTitle ?? candidate.extractedFields?.chosen.title,
          author: correction.correctedAuthor ?? candidate.extractedFields?.chosen.author,
        },
      },
    };
  });
}

/**
 * Save a new correction
 */
function saveCorrection(
  candidate: BookCandidate,
  correctedTitle: string | null,
  correctedAuthor: string | null
): void {
  const store = useCorrectionsStore.getState();
  const key = candidate.extractedFields?.chosen.isbn || generateContentHash(candidate.evidence);

  const correction: Correction = {
    contentHash: generateContentHash(candidate.evidence),
    isbn: candidate.extractedFields?.chosen.isbn || null,
    correctedTitle,
    correctedAuthor,
    originalTitle: candidate.extractedFields?.chosen.title || null,
    originalAuthor: candidate.extractedFields?.chosen.author || null,
    createdAt: new Date().toISOString(),
    applyCount: 0,
  };

  store.setCorrection(key, correction);
}

/**
 * Revert to auto-detected values
 */
function revertCorrection(candidate: BookCandidate): void {
  const store = useCorrectionsStore.getState();
  const key = candidate.extractedFields?.chosen.isbn || generateContentHash(candidate.evidence);
  store.deleteCorrection(key);
}
```

#### Corrections Store

```typescript
// src/store/useCorrectionsStore.ts

import { create } from 'zustand';
import { storage } from './useAppStore';

const CORRECTIONS_KEY = 'corrections_memory';

interface CorrectionsState {
  corrections: Record<string, Correction>;
  setCorrection: (key: string, correction: Correction) => void;
  deleteCorrection: (key: string) => void;
  loadCorrections: () => void;
}

export const useCorrectionsStore = create<CorrectionsState>((set, get) => ({
  corrections: {},

  setCorrection: (key, correction) => {
    const corrections = { ...get().corrections, [key]: correction };
    set({ corrections });
    storage.set(CORRECTIONS_KEY, JSON.stringify(corrections));
  },

  deleteCorrection: (key) => {
    const corrections = { ...get().corrections };
    delete corrections[key];
    set({ corrections });
    storage.set(CORRECTIONS_KEY, JSON.stringify(corrections));
  },

  loadCorrections: () => {
    try {
      const data = storage.getString(CORRECTIONS_KEY);
      if (data) {
        set({ corrections: JSON.parse(data) });
      }
    } catch (e) {
      console.error('[CorrectionsStore] Failed to load:', e);
    }
  },
}));
```

#### UI Changes

Add "Edited" indicator and revert option:

```
┌────────────────────────────────────────┐
│ Book 1                    [Edited ✎]   │
├────────────────────────────────────────┤
│ Title: The Great Gatsby                │
│ Author: F. Scott Fitzgerald            │
│                                        │
│ [Edit]  [Revert to auto]               │
└────────────────────────────────────────┘
```

When a correction is auto-applied, show a subtle indicator:

```
┌────────────────────────────────────────┐
│ Book 1                    [Auto ↻]     │
├────────────────────────────────────────┤
│ Title: The Great Gatsby                │
│   (corrected from "The Gr3at Gatsby")  │
...
```

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/correctionsMemory.test.ts` | Hash generation, matching, apply/revert |
| `src/store/__tests__/useCorrectionsStore.test.ts` | Persistence, CRUD operations |

```typescript
// Example test cases
describe('correctionsMemory', () => {
  it('generates stable hash from evidence', () => {});
  it('matches by ISBN when available', () => {});
  it('matches by content hash when no ISBN', () => {});
  it('applies correction to candidate', () => {});
  it('increments apply count on each use', () => {});
  it('reverts correction and deletes from store', () => {});
});

describe('useCorrectionsStore', () => {
  it('persists corrections to MMKV', () => {});
  it('loads corrections on init', () => {});
  it('deletes specific correction', () => {});
});
```

#### Validation Commands

```bash
# Run unit tests
npx jest src/services/__tests__/correctionsMemory.test.ts --watchman=false
npx jest src/store/__tests__/useCorrectionsStore.test.ts --watchman=false

# Manual validation
# 1. Scan a book with OCR error
# 2. Edit to correct title
# 3. Clear session, rescan same book
# 4. Verify corrected title appears automatically
# 5. Verify "Auto-applied" indicator shows
# 6. Tap "Revert to auto" and verify original appears
```

#### Acceptance Criteria

- [ ] Edit once, rescan same book, correction auto-applies
- [ ] ISBN-based matching works when ISBN detected
- [ ] Content-hash matching works when no ISBN
- [ ] "Edited" indicator shows for manual corrections
- [ ] "Auto-applied" indicator shows for remembered corrections
- [ ] "Revert to auto" removes correction and shows original
- [ ] Apply count tracks how many times correction used

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Hash collision (different books match same hash) | Include enough content; use ISBN when available |
| Corrections become stale (book republished) | Show original value; easy revert; consider TTL |
| Storage bloat (too many corrections) | Implement LRU eviction; export/import corrections |

---

## Execution Strategy

### Critical Rules

1. **Do NOT implement as one mega patch.** Each gate is a separate PR/commit series.

2. **Each gate must leave the app working.** No half-implemented features that break existing functionality.

3. **Keep metadata lookup feature-flagged until stable.** Gate 9 must be OFF by default until thoroughly tested.

4. **Maintain single source of truth.** All new data flows through `SessionMeta` in Zustand store.

5. **No localhost fallbacks.** The app must work fully offline (except Gate 9 when enabled).

6. **Preserve existing patterns:**
   - Debug artifacts gated by `DEBUG_ARTIFACTS_ENABLED`
   - Platform-specific code in separate modules
   - Type definitions in `src/types/index.ts`
   - Services in `src/services/`
   - Tests alongside code in `__tests__/`

### Recommended Order

```
Gate 7 (Grouping) ──▶ Gate 8 (Extraction) ──▶ Gate 9 (Resolver) ──▶ Gate 10 (Memory)
     │                      │                       │                     │
     │                      │                       │                     │
     ▼                      ▼                       ▼                     ▼
[Merge PR]            [Merge PR]              [Merge PR]           [Merge PR]
[Test on device]      [Test on device]        [Test on device]     [Test on device]
[Verify no regressions]                       [Keep flag OFF]
```

### Per-Gate Checklist

Before merging each gate:

- [ ] All new unit tests passing
- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] Existing tests still pass (`npx jest --watchman=false`)
- [ ] Manual device test on iOS (primary platform)
- [ ] Manual device test on Android (verify no crashes, even if features limited)
- [ ] No regressions in existing functionality
- [ ] Code review completed
- [ ] Documentation updated if needed

### Testing Strategy

| Level | Tools | Coverage |
|-------|-------|----------|
| Unit | Jest | Individual functions, algorithms |
| Integration | Jest + mocks | Service interactions |
| Device | Manual | End-to-end on real device |
| Regression | Fixtures | Known books with expected output |

### Feature Flag Progression

```
Gate 9 Implementation:
  METADATA_LOOKUP_ENABLED = false (development)
                         → false (merged to main)
                         → true (testing branch)
                         → false (stable release)
                         → true (opt-in release)
```

---

## Appendix: Type Definitions

All new types should be added to `src/types/index.ts`. Here's the complete set:

```typescript
// ============================================================================
// Gate 7: Book Candidate Grouping
// ============================================================================

export interface EvidenceLine {
  text: string;
  confidence: number;
  sourceCropIndex: number;
  sourceRotation: number;
  bbox?: OCRBoundingBox;
}

export interface MergedEvidence {
  lines: EvidenceLine[];
  fullText: string;
  contributingCrops: number[];
  avgConfidence: number;
}

export interface BookCandidate {
  candidateId: string;
  detectionIndices: number[];
  cropIndices: number[];
  evidence: MergedEvidence;
  shelfPosition: number;
  centroid: { x: number; y: number };
  extractedFields?: ExtractedFields;
  resolvedMetadata?: ResolvedMetadata;
  appliedCorrection?: Correction;
}

// ============================================================================
// Gate 8: Field Extraction
// ============================================================================

export interface FieldCandidate {
  value: string;
  confidence: number;
  source: 'ocr' | 'pattern' | 'inferred';
  sourceLines: number[];
}

export interface ExtractedFields {
  titleCandidates: FieldCandidate[];
  authorCandidates: FieldCandidate[];
  isbn: FieldCandidate | null;
  publisherCandidates: FieldCandidate[];
  editionCandidates: FieldCandidate[];
  chosen: {
    title: string | null;
    author: string | null;
    isbn: string | null;
    publisher: string | null;
    edition: string | null;
  };
}

// ============================================================================
// Gate 9: Resolver
// ============================================================================

export interface ResolvedMetadata {
  title: string;
  authors: string[];
  isbn13: string | null;
  isbn10: string | null;
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: 'openLibrary' | 'googleBooks';
  sourceId: string;
  matchConfidence: number;
  autoAccepted: boolean;
  suggestions?: ResolvedMetadata[];
}

export interface LookupProvider {
  name: string;
  lookupByIsbn(isbn: string): Promise<ResolvedMetadata | null>;
  search(title: string, author?: string): Promise<ResolvedMetadata[]>;
}

// ============================================================================
// Gate 10: Corrections Memory
// ============================================================================

export interface Correction {
  contentHash: string;
  isbn: string | null;
  correctedTitle: string | null;
  correctedAuthor: string | null;
  originalTitle: string | null;
  originalAuthor: string | null;
  createdAt: string;
  applyCount: number;
}
```

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-19 | Claude | Initial creation with Gates 7-10 roadmap |
| 2026-01-20 | Claude | Updated: Gate 7 (grouping) implemented, metadata resolution services implemented (feature-flagged), pipeline integration complete |
| 2026-01-20 | Claude | **CRITICAL FIX**: Gate 7 grouping rewritten with conservative algorithm. Old algorithm was merging all 10 spines into 1 candidate. New algorithm: only merge on high IoU (≥0.50) or OCR-confirmed split-detection. Added safety cap (max 3 crops/candidate). Added `grouping_assignments.json` debug artifact. 19 comprehensive tests. 424 total tests passing. |
