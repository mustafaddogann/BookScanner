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
   - [Gate 8: Hypothesis Generation](#gate-8-hypothesis-generation)
   - [Gate 9: Resolver + Scoring + Verification + Acceptance](#gate-9-resolver--scoring--verification--acceptance)
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
│                                                                     │
│  RESOLVER-CENTRIC ARCHITECTURE:                                     │
│  • Canonical truth comes from resolver decisions (Gate 9)           │
│  • Gate 8 is hypothesis generation only (NOT canonical)             │
│  • App displays hypothesis until resolver returns canonical data    │
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
│  │ GATE 8: HYPOTHESIS GENERATION (on-device, NOT canonical)│       │
│  │ • Classify evidence tier: strong/usable/weak/unusable   │       │
│  │ • Generate search candidates (queries for resolver)     │       │
│  │ • Extract ISBN candidates                               │       │
│  │ • Produce UI guess (for immediate display)              │       │
│  │ • Output: BookCandidate.{evidenceTier, searchCandidates,│       │
│  │           isbnCandidates, uiGuess}                      │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ GATE 9: RESOLVER (Supabase Edge Function, feature-flag) │       │
│  │ • Called by app when enabled + online                   │       │
│  │ • Scoring: OpenLibrary, cover match, ISBN verification  │       │
│  │ • Verification: accept/reject/manual_review decision    │       │
│  │ • Output: ResolvedMetadata (CANONICAL)                  │       │
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

// Gate 8: Hypothesis generation (always runs on-device, NOT canonical)
const hypothesisCandidates = hypothesisGenerationService.generate(mergedCandidates);
// Each candidate now has: evidenceTier, searchCandidates, isbnCandidates, uiGuess

// Gate 9: Resolver (Supabase Edge Function, feature-flagged)
// CANONICAL truth comes from here when enabled
const resolvedCandidates = METADATA_RESOLUTION_ENABLED && isOnline
  ? await resolverService.resolve(hypothesisCandidates)
  : hypothesisCandidates; // Show uiGuess until resolved

// Gate 10: Apply corrections memory
const finalCandidates = correctionsMemory.apply(resolvedCandidates);

// Store in SessionMeta
setSessionMeta({
  ...sessionMeta,
  bookCandidates: finalCandidates,
});
```

**Resolver-Centric Data Flow:**
```
OCR Evidence → Gate 8 (hypothesis) → Gate 9 (resolver) → Canonical Data
                    │                       │
                    │                       └─▶ ResolvedMetadata (canonical)
                    └─▶ uiGuess (for immediate display while awaiting resolver)
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

### Gate 8: Hypothesis Generation

**IMPORTANT: Gate 8 output is NOT canonical.** It provides hypotheses for the resolver (Gate 9) to verify and make canonical decisions.

#### Resolver-Centric Philosophy

In the resolver-centric architecture:
- **Gate 8 (on-device)**: Generates hypotheses - search queries, ISBN candidates, evidence tier, UI guess
- **Gate 9 (Supabase Edge Function)**: Makes canonical decisions - scoring, verification, acceptance
- **Canonical truth** comes from resolver, not local extraction
- **UI displays `uiGuess`** immediately, updates when resolver returns

#### Problem

We need to prepare evidence for the resolver:
1. Classify evidence quality (strong/usable/weak/unusable)
2. Generate search candidates (queries for metadata lookup)
3. Extract ISBN candidates for direct lookup
4. Produce a UI guess for immediate display

#### Evidence Tier Classification

| Tier | Multiplier | Criteria |
|------|------------|----------|
| `strong` | 1.0 | avgConfidence ≥ 0.85 AND ≥3 lines AND alnumRatio ≥ 0.80 |
| `usable` | 0.85 | avgConfidence ≥ 0.70 AND ≥2 lines AND alnumRatio ≥ 0.65 |
| `weak` | 0.6 | avgConfidence ≥ 0.50 AND ≥1 line |
| `unusable` | 0 | Everything else (skip resolver call) |

```typescript
// In evidenceQualityService.ts
export const TIER_MULTIPLIERS: Record<EvidenceTier, number> = {
  strong: 1.0,
  usable: 0.85,
  weak: 0.6,
  unusable: 0,
};
```

#### Hypothesis Generation Rules

1. **If ISBN candidate exists:**
   - Add direct ISBN lookup query
   - Still generate title/author queries as fallback

2. **If tier is `unusable`:**
   - Set `searchCandidates = []`
   - Set `uiGuess = null`
   - Skip resolver call (waste of API quota)

3. **UI guess generation:**
   - Use existing line labeling pipeline (Filter → Label → Assemble)
   - `uiGuess = { title, author, confidence }` for immediate display
   - Not canonical - will be replaced by resolver output

#### Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/services/hypothesisGenerationService.ts` | Service | Orchestrate Gate 8 hypothesis generation |
| `src/services/evidenceQualityService.ts` | Service | Classify evidence tier (already exists) |
| `src/services/searchCandidateService.ts` | Service | Generate search candidates (already exists) |
| `src/services/spineFieldExtractionService.ts` | Service | Extract title/author for uiGuess (already exists) |
| `src/utils/isbnUtils.ts` | Utility | ISBN validation (already exists) |

#### Data Contracts

```typescript
// Added to BookCandidate interface
export interface BookCandidate {
  // ... existing fields ...

  /** Evidence quality tier (Gate 8) */
  evidenceTier?: EvidenceTier;

  /** Search candidates for resolver (Gate 8) */
  searchCandidates?: SearchCandidate[];

  /** ISBN candidates extracted from OCR (Gate 8) */
  isbnCandidates?: string[];

  /** UI guess for immediate display (NOT canonical) (Gate 8) */
  uiGuess?: {
    title: string | null;
    author: string | null;
    confidence: number;
  };
}
```

#### Algorithm: hypothesisGenerationService

```typescript
// src/services/hypothesisGenerationService.ts

import { classifyEvidence } from './evidenceQualityService';
import { buildSearchCandidates } from './searchCandidateService';
import { extractTitlesAndAuthors } from './spineFieldExtractionService';
import { extractIsbnCandidates } from '../utils/isbnUtils';

export function generateHypothesis(candidate: BookCandidate): BookCandidate {
  // 1. Classify evidence tier
  const evidenceTier = classifyEvidence(candidate.evidence);

  // 2. If unusable, skip further processing
  if (evidenceTier === 'unusable') {
    return {
      ...candidate,
      evidenceTier,
      searchCandidates: [],
      isbnCandidates: [],
      uiGuess: null,
    };
  }

  // 3. Extract ISBN candidates from evidence lines
  const isbnCandidates = extractIsbnCandidates(candidate.evidence.mergedLines);

  // 4. Build search candidates for resolver
  const searchCandidates = buildSearchCandidates(candidate.evidence, evidenceTier);

  // 5. Generate UI guess using line labeling pipeline
  const fieldExtraction = extractTitlesAndAuthors(candidate.evidence);
  const uiGuess = fieldExtraction.length > 0
    ? {
        title: fieldExtraction[0].title,
        author: fieldExtraction[0].author,
        confidence: fieldExtraction[0].confidence,
      }
    : null;

  return {
    ...candidate,
    evidenceTier,
    searchCandidates,
    isbnCandidates,
    uiGuess,
  };
}

export function generateHypotheses(candidates: BookCandidate[]): BookCandidate[] {
  return candidates.map(generateHypothesis);
}
```

#### Line Labeling Pipeline (for uiGuess)

The existing line labeling services are used to generate `uiGuess`:

```
OCR Lines → Filter (OTHER) → Label (scores) → Assemble → Validate
```

| Service | Purpose |
|---------|---------|
| `spineLineFilter.ts` | Hard filter for ISBN, publisher, price, URL, copyright |
| `spineLineLabeler.ts` | Score lines for title vs author likelihood |
| `spineTitleAuthorAssembler.ts` | Assemble title/author from labeled lines |
| `spineSwapGuard.ts` | Detect and validate title/author swaps |
| `mixedOrientationMerger.ts` | Merge multi-rotation OCR evidence |

**Key Features:**
- Context-aware publisher filtering ("Thomas" when "Books" nearby)
- Multi-line author joining ("Laura" + "Bates" → "Laura Bates")
- Subtitle preservation ("Title: Subtitle" stays together)
- Combined line splitting ("Author • Title" patterns)
- Swap detection and correction

#### UI Changes

Add debug section in Results "Books" tab when `DEBUG_ARTIFACTS_ENABLED`:

```
┌────────────────────────────────────────┐
│ Book 1                                 │
├────────────────────────────────────────┤
│ [UI Guess - not canonical]             │
│ Title: The Great Gatsby                │
│ Author: F. Scott Fitzgerald            │
│ Confidence: 0.85                       │
│                                        │
│ [Debug: Gate 8 Hypothesis]             │
│ Evidence Tier: strong (1.0x)           │
│ ISBN Candidates: 978-0743273565        │
│ Search Queries:                        │
│   • "The Great Gatsby Fitzgerald"      │
│   • "978-0743273565"                   │
│                                        │
│ [Resolver Status: Pending]             │
└────────────────────────────────────────┘
```

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/evidenceQualityService.test.ts` | Tier classification |
| `src/services/__tests__/searchCandidateService.test.ts` | Query building |
| `src/services/__tests__/hypothesisGenerationService.test.ts` | Full Gate 8 pipeline |
| `src/services/__tests__/gate8FieldExtraction.test.ts` | Line labeling (50 tests) |

```typescript
describe('evidenceQualityService', () => {
  it('classifies high quality evidence as strong', () => {});
  it('classifies medium quality evidence as usable', () => {});
  it('classifies poor quality evidence as weak', () => {});
  it('classifies empty/garbage evidence as unusable', () => {});
  it('returns correct tier multipliers', () => {});
});

describe('searchCandidateService', () => {
  it('builds title+author query from evidence', () => {});
  it('includes ISBN as separate query when detected', () => {});
  it('filters noise tokens from queries', () => {});
  it('applies tier multiplier to confidence', () => {});
});

describe('hypothesisGenerationService', () => {
  it('generates complete hypothesis for strong evidence', () => {});
  it('returns empty candidates for unusable evidence', () => {});
  it('extracts ISBN candidates from evidence', () => {});
  it('generates uiGuess using line labeling pipeline', () => {});
});
```

#### Validation Commands

```bash
# Run hypothesis generation tests
npx jest src/services/__tests__/hypothesisGenerationService.test.ts --watchman=false
npx jest src/services/__tests__/evidenceQualityService.test.ts --watchman=false
npx jest src/services/__tests__/searchCandidateService.test.ts --watchman=false

# Run all Gate 8 tests (including line labeling)
npx jest --testPathPattern="gate8" --watchman=false

# TypeScript check
npx tsc --noEmit
```

#### Acceptance Criteria

- [x] Evidence tier classification working (50 tests)
- [ ] Hypothesis generation service created
- [ ] ISBN candidates extracted from evidence
- [ ] Search candidates built with tier multipliers
- [ ] uiGuess generated using line labeling pipeline
- [ ] BookCandidate type updated with new fields
- [ ] Debug UI shows Gate 8 outputs
- [ ] Feature flag controls debug UI visibility

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Poor evidence → poor queries | Tier-based filtering: unusable evidence skips resolver |
| ISBN false positives | ISBN validation with check digit verification |
| UI guess too wrong | Clear "not canonical" labeling; update when resolver returns |
| Debug UI cluttered | Only show when DEBUG_ARTIFACTS_ENABLED |

---

### Gate 9: Resolver + Scoring + Verification + Acceptance

**Feature-flagged OFF by default. Runs in Supabase Edge Function.**

#### Resolver-Centric Philosophy

Gate 9 is the **canonical source of truth** for book metadata. The resolver:
- Receives hypothesis from Gate 8 (search candidates, ISBN candidates, evidence tier)
- Performs lookup against metadata sources (Open Library, potentially others)
- Scores and verifies matches
- Makes acceptance decisions (accept/reject/manual_review)
- Returns canonical `ResolvedMetadata` to the app

**IMPORTANT**: All canonical decisions happen server-side (Supabase Edge Function). The app only displays the resolver's output, never makes canonical decisions locally.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           APP (React Native)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Gate 8 Output: { evidenceTier, searchCandidates, isbnCandidates } │
│                              │                                      │
│                              ▼                                      │
│                    [METADATA_RESOLUTION_ENABLED?]                   │
│                        │              │                             │
│                       YES            NO                             │
│                        │              │                             │
│                        ▼              ▼                             │
│                  POST to Supabase    Show uiGuess only              │
│                        │                                            │
└────────────────────────┼────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  SUPABASE EDGE FUNCTION (Gate 9)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. LOOKUP                                                          │
│     • ISBN lookup (if isbnCandidates provided)                     │
│     • Title+Author search (using searchCandidates)                 │
│                                                                     │
│  2. SCORING                                                         │
│     • Title similarity (Levenshtein normalized)                    │
│     • Author similarity                                            │
│     • ISBN match bonus                                             │
│     • Tier multiplier applied (strong=1.0, usable=0.85, weak=0.6) │
│     • Cover match (future: image similarity)                       │
│                                                                     │
│  3. VERIFICATION                                                    │
│     • Confidence gap check (best vs second)                        │
│     • Minimum confidence threshold                                 │
│     • ISBN verification (check digit)                              │
│                                                                     │
│  4. ACCEPTANCE DECISION                                             │
│     • accept: High confidence, clear winner                        │
│     • reject: No viable matches                                    │
│     • manual_review: Ambiguous, needs user input                   │
│                                                                     │
│  Return: ResolvedMetadata (CANONICAL)                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Deliverables

**App-side (React Native):**

| File | Type | Description |
|------|------|-------------|
| `src/config/supabase.ts` | Config | Supabase client configuration with MMKV storage adapter |
| `src/services/supabaseResolverClient.ts` | Service | Client to call Supabase Edge Function |
| `src/services/offlineResolverQueue.ts` | Queue | MMKV-based offline queue with NetInfo auto-processing |
| `src/utils/evidenceHash.ts` | Utility | Evidence hash generation for cache keys |
| `src/config/debug.ts` | Config | `METADATA_RESOLUTION_ENABLED` flag |

**Server-side (Supabase Edge Function):**

| File | Type | Description |
|------|------|-------------|
| `supabase/migrations/20260123000001_resolver_tables.sql` | SQL | Database schema (resolver_cache, user_corrections, resolver_events) |
| `supabase/functions/resolve_candidates/index.ts` | Function | Main resolver endpoint with rate limiting |
| `supabase/functions/_shared/types.ts` | Types | Request/response types, scoring weights, acceptance thresholds |
| `supabase/functions/_shared/utils.ts` | Module | Scoring, verification, Open Library mapping utilities |

#### Data Contracts

```typescript
// Request to resolver (from app to Supabase)
export interface ResolverRequest {
  /** Evidence tier from Gate 8 */
  evidenceTier: EvidenceTier;
  /** Search candidates for lookup */
  searchCandidates: SearchCandidate[];
  /** ISBN candidates for direct lookup */
  isbnCandidates: string[];
  /** Session ID for tracking */
  sessionId: string;
  /** Candidate ID for tracking */
  candidateId: string;
}

// Response from resolver (canonical)
export interface ResolverResponse {
  /** Whether resolution was successful */
  success: boolean;
  /** Acceptance decision */
  decision: 'accept' | 'reject' | 'manual_review';
  /** Resolved metadata (if decision is accept) */
  resolvedMetadata?: ResolvedMetadata;
  /** Top suggestions (if decision is manual_review) */
  suggestions?: ResolvedMetadata[];
  /** Reason for decision */
  reason: string;
  /** Scoring breakdown (for debug) */
  scoring?: ScoringBreakdown;
}

// Resolved metadata (canonical)
export interface ResolvedMetadata {
  /** Canonical title */
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
}
```

#### Scoring Algorithm

```typescript
// In supabase/functions/resolve-book/scoring.ts

const TIER_MULTIPLIERS = {
  strong: 1.0,
  usable: 0.85,
  weak: 0.6,
  unusable: 0,
};

export function computeMatchScore(
  query: SearchCandidate,
  result: LookupResult,
  tierMultiplier: number
): number {
  let score = 0;

  // 1. Title similarity (40% weight)
  const titleSim = levenshteinSimilarity(query.titleHint, result.title);
  score += titleSim * 0.4;

  // 2. Author similarity (30% weight)
  if (query.authorHint && result.authors.length > 0) {
    const authorSim = bestAuthorMatch(query.authorHint, result.authors);
    score += authorSim * 0.3;
  }

  // 3. ISBN match bonus (20% weight)
  if (query.isbn && (result.isbn13 === query.isbn || result.isbn10 === query.isbn)) {
    score += 0.2;
  }

  // 4. Position penalty (10% weight)
  // Earlier results from search are more likely correct
  const positionPenalty = 1 - (result.position / 10);
  score += positionPenalty * 0.1;

  // Apply tier multiplier
  return score * tierMultiplier;
}
```

#### Acceptance Decision Logic

```typescript
// In supabase/functions/resolve-book/acceptance.ts

const MIN_ACCEPT_CONFIDENCE = 0.75;
const CONFIDENCE_GAP_THRESHOLD = 0.25;
const MIN_REVIEW_CONFIDENCE = 0.50;

export function makeAcceptanceDecision(
  scored: ScoredMatch[]
): AcceptanceDecision {
  if (scored.length === 0) {
    return { decision: 'reject', reason: 'No matches found' };
  }

  const best = scored[0];
  const second = scored[1];
  const gap = second ? best.score - second.score : 1.0;

  // Accept: High confidence with clear gap
  if (best.score >= MIN_ACCEPT_CONFIDENCE && gap >= CONFIDENCE_GAP_THRESHOLD) {
    return {
      decision: 'accept',
      reason: `High confidence match (${best.score.toFixed(2)})`,
      resolvedMetadata: best.metadata,
    };
  }

  // Manual review: Multiple viable candidates
  if (best.score >= MIN_REVIEW_CONFIDENCE) {
    return {
      decision: 'manual_review',
      reason: `Ambiguous match (gap: ${gap.toFixed(2)})`,
      suggestions: scored.slice(0, 3).map(s => s.metadata),
    };
  }

  // Reject: No viable matches
  return {
    decision: 'reject',
    reason: `Best match below threshold (${best.score.toFixed(2)})`,
  };
}
```

#### App-side Client

```typescript
// src/services/resolverClientService.ts

import { isMetadataResolutionEnabled } from '../config/debug';

const SUPABASE_FUNCTION_URL = 'https://<project>.supabase.co/functions/v1/resolve-book';

export async function resolveCandidate(
  candidate: BookCandidate
): Promise<BookCandidate> {
  // 1. Check feature flag
  if (!isMetadataResolutionEnabled()) {
    return candidate; // Show uiGuess only
  }

  // 2. Check evidence tier
  if (candidate.evidenceTier === 'unusable') {
    return candidate; // Skip resolver for unusable evidence
  }

  // 3. Check cache
  const cacheKey = getCacheKey(candidate);
  const cached = resolverCache.get(cacheKey);
  if (cached) {
    return { ...candidate, resolvedMetadata: cached };
  }

  // 4. Call Supabase Edge Function
  const request: ResolverRequest = {
    evidenceTier: candidate.evidenceTier!,
    searchCandidates: candidate.searchCandidates || [],
    isbnCandidates: candidate.isbnCandidates || [],
    sessionId: getCurrentSessionId(),
    candidateId: candidate.id,
  };

  try {
    const response = await fetch(SUPABASE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const result: ResolverResponse = await response.json();

    // 5. Process result
    if (result.decision === 'accept' && result.resolvedMetadata) {
      resolverCache.set(cacheKey, result.resolvedMetadata);
      return { ...candidate, resolvedMetadata: result.resolvedMetadata };
    }

    if (result.decision === 'manual_review' && result.suggestions) {
      return { ...candidate, resolverSuggestions: result.suggestions };
    }

    // Reject or error: keep uiGuess
    return candidate;

  } catch (error) {
    console.error('[ResolverClient] Error:', error);
    return candidate; // Graceful degradation: show uiGuess
  }
}
```

#### Feature Flag

```typescript
// In src/config/debug.ts

export const METADATA_RESOLUTION_ENABLED = false; // OFF by default
```

When enabled:
- App calls Supabase Edge Function for each candidate with non-unusable evidence
- Resolver response replaces `uiGuess` with canonical `resolvedMetadata`
- Cache prevents repeated API calls

When disabled:
- No network calls made
- App displays `uiGuess` from Gate 8 (non-canonical)
- User can still manually edit

#### Tests

| Test File | Coverage |
|-----------|----------|
| `src/services/__tests__/resolverClientService.test.ts` | Client logic, caching, error handling |
| `supabase/functions/resolve-book/__tests__/scoring.test.ts` | Scoring algorithm |
| `supabase/functions/resolve-book/__tests__/acceptance.test.ts` | Decision logic |

```typescript
describe('resolverClientService', () => {
  it('returns candidate unchanged when feature flag is off', () => {});
  it('skips resolver for unusable evidence', () => {});
  it('returns cached result on cache hit', () => {});
  it('calls Supabase function and caches accept result', () => {});
  it('handles manual_review with suggestions', () => {});
  it('gracefully degrades on network error', () => {});
});

describe('scoring', () => {
  it('applies tier multiplier to final score', () => {});
  it('weights title similarity at 40%', () => {});
  it('weights author similarity at 30%', () => {});
  it('gives ISBN match 20% bonus', () => {});
});

describe('acceptance', () => {
  it('accepts high confidence with clear gap', () => {});
  it('returns manual_review for ambiguous matches', () => {});
  it('rejects when best match below threshold', () => {});
});
```

#### Validation Commands

```bash
# App-side tests
npx jest src/services/__tests__/resolverClientService.test.ts --watchman=false

# Server-side tests (requires Deno)
cd supabase/functions/resolve-book
deno test

# Manual validation (with feature flag ON)
# 1. Scan book with clear spine
# 2. Verify canonical metadata from resolver
# 3. Check cache prevents repeated calls
# 4. Test offline behavior (graceful degradation)
```

#### Acceptance Criteria

- [x] Supabase Edge Function created (`supabase/functions/resolve_candidates/`)
- [x] Database schema with resolver_cache, user_corrections, resolver_events tables
- [x] RLS policies for cache and corrections
- [x] App client calls function when enabled + online (`supabaseResolverClient.ts`)
- [x] Scoring applies tier multipliers correctly (ACCEPTANCE_THRESHOLDS per tier)
- [x] Acceptance decision logic working (auto-accept/suggest/ambiguous/no-match)
- [x] MMKV-based offline queue for retry (`offlineResolverQueue.ts`)
- [x] Graceful degradation on network error
- [x] Feature flag OFF prevents any network calls
- [x] Unit tests for client-side scoring/verification (10 tests)
- [x] Evaluation script for fixture testing (`scripts/evaluate_fixtures.ts`)
- [ ] Production Supabase deployment (requires project URL/anon key)

#### Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Supabase function cold starts | Warm function with keep-alive; show loading state |
| Open Library rate limits | Server-side caching; batch requests if possible |
| Wrong matches for common titles | Confidence gap threshold; manual_review for ambiguous |
| Network failures | Graceful degradation to uiGuess; offline queue (Gate 10) |
| Privacy concerns | Feature flag OFF by default; clear data sent disclosure |

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
| 2026-01-23 | Claude | **RESOLVER-CENTRIC REDESIGN**: Renamed Gate 8 to "Hypothesis Generation" (NOT canonical). Renamed Gate 9 to "Resolver + Scoring + Verification + Acceptance" (Supabase Edge Function). Canonical truth now comes from resolver, not local extraction. Gate 8 produces evidenceTier, searchCandidates, isbnCandidates, uiGuess. Gate 9 makes accept/reject/manual_review decisions server-side. 474 tests passing. |
| 2026-01-23 | Claude | **GATE 9 SUPABASE IMPLEMENTATION**: Created Supabase Edge Function `resolve_candidates` with Open Library API integration. Database schema with resolver_cache (7-day TTL), user_corrections (RLS per user), resolver_events (analytics). React Native client (`supabaseResolverClient.ts`) with MMKV-based offline queue (`offlineResolverQueue.ts`). Scoring uses weighted signals (titleSimilarity 0.35, authorPresence 0.25, isbnMatch 0.25, tokenCoverage 0.10, positionBonus 0.05). Tier-based acceptance thresholds (strong: 0.72, usable: 0.78, weak: 0.88). Verification flags for author-mismatch, isbn-mismatch, token-coverage-low. Evaluation script `scripts/evaluate_fixtures.ts`. 527 tests passing. |
