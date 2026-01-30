# Stop-the-Line Gates

Hard pass/fail checklist. Each gate must pass before proceeding to the next.

**Related Documentation:**
- [docs/project_plan.md](./project_plan.md) - Project roadmap and Gates 7-10
- [docs/pipeline.md](./pipeline.md) - Pipeline stage documentation
- [docs/build.md](./build.md) - Build troubleshooting

---

## Gate Overview

| Gate | Stage | Status |
|------|-------|--------|
| 0 | Dataset Integrity | Core pipeline |
| 1 | Model Training | Core pipeline |
| 2 | TFLite Export | Core pipeline |
| 3 | Model IO Contract | Core pipeline |
| 4 | Decode Logic | Core pipeline |
| 5 | End-to-End Pipeline | Core pipeline |
| 6 | OCR + Post-processing | Core pipeline |
| 7-10 | Metadata Extraction | See [project_plan.md](./project_plan.md) |

---

## Gate 0: Dataset Integrity

**Pass criteria:**
- [ ] `ml/datasets/open_shelves/` contains `train/` and `valid/` directories
- [ ] `train/images/` and `train/labels/` are non-empty
- [ ] `valid/images/` and `valid/labels/` are non-empty
- [ ] `data.yaml` exists with correct paths and class names
- [ ] Label files use OBB format: `class_id x1 y1 x2 y2 x3 y3 x4 y4`

**Verify:**
```bash
ls ml/datasets/open_shelves/train/images | wc -l
ls ml/datasets/open_shelves/train/labels | wc -l
head -1 ml/datasets/open_shelves/train/labels/*.txt | head -5
```

**Fail action:** Fix dataset paths or re-download from Roboflow.

---

## Gate 1: Model Training Completes

**Pass criteria:**
- [ ] `ml/runs/obb/train/weights/best.pt` exists
- [ ] Training log shows decreasing loss
- [ ] mAP50 > 0.1 on validation set (proves model learned something)

**Verify:**
```bash
ls -la ml/runs/obb/train/weights/best.pt
grep "mAP50" ml/runs/obb/train/results.csv | tail -1
```

**Fail action:** Check dataset labels, increase epochs, verify GPU.

---

## Gate 2: TFLite Export Succeeds

**Pass criteria:**
- [ ] `src/models/yolov8_obb.tflite` exists
- [ ] File size > 1MB (not empty/corrupt)
- [ ] Export completed without errors

**Verify:**
```bash
ls -la src/models/yolov8_obb.tflite
```

**Fail action:** Check Ultralytics export logs, verify best.pt is valid.

---

## Gate 3: Model IO Contract Inspected

**Pass criteria:**
- [ ] Input tensor shape documented (expected: `[1, 640, 640, 3]` or `[1, 3, 640, 640]`)
- [ ] Output tensor shape documented
- [ ] Output format understood (raw anchors vs decoded boxes)
- [ ] `ml/model_io_contract.json` written with exact tensor specs

**Verify:**
```bash
cat ml/model_io_contract.json
```

**Fail action:** Re-run tensor inspection script, consult Ultralytics docs.

---

## Gate 4: Decode Logic Matches Output

**Pass criteria:**
- [ ] Decode function handles actual output tensor shape
- [ ] Test image produces non-zero detections
- [ ] Detections map correctly to original image coordinates
- [ ] `coordinate_test.json` artifact proves mapping works

**Verify:**
```bash
# Run inference on test fixture
npm test -- --testPathPattern="inference"
```

**Fail action:** Debug decode logic against raw tensor output.

---

## Gate 5: End-to-End Pipeline Produces Valid Output

**Pass criteria:**
- [ ] Camera capture → detection → overlay works on device
- [ ] Fixture → detection → overlay works on device
- [ ] `debug_manifest.json` contains valid detections
- [ ] Overlay polygons align with visible book spines
- [ ] Rectified crops show upright text (iOS only)

**Verify:**
```bash
# Manual device test - check Documents/sessions/*/debug_manifest.json
```

**Fail action:** Check coordinate mapping, angle convention, screen mapping.

---

## Gate 6: OCR + Post-Processing Works

**Pass criteria:**
- [ ] iOS: Vision framework text recognition produces output
- [ ] Android: ML Kit text recognition produces output (or graceful fallback)
- [ ] Rotation trials (0°, 90°, 180°, 270°) select best by confidence
- [ ] OCR results stored in `SessionMeta.ocrResultsByCropIndex`
- [ ] Title/author candidates extracted via heuristics
- [ ] Noise filtered (ISBN patterns, URLs, prices)
- [ ] Results UI shows OCR text below each crop
- [ ] Edit modal allows user corrections

**Verify:**
```bash
# Run OCR service tests
npx jest src/services/__tests__/textRecognitionService.test.ts --watchman=false
npx jest src/services/__tests__/ocrPostProcessingService.test.ts --watchman=false

# TypeScript check
npx tsc --noEmit

# Manual device test
# 1. Scan a bookshelf
# 2. Go to Results → Crops tab
# 3. Verify OCR text appears below each crop
# 4. Tap to edit, save changes
```

**Fail action:** Check native module implementation, rotation trial logic, heuristics.

---

## Gates 7-10: Structured Metadata Extraction

**RESOLVER-CENTRIC ARCHITECTURE**: Canonical truth comes from the resolver (Gate 9), not local extraction. Gate 8 generates hypotheses for the resolver to verify.

Gates 7-10 cover advanced metadata extraction and are documented separately:

| Gate | Description | Documentation |
|------|-------------|---------------|
| 7 | Book Candidate Grouping + Evidence Merge | [project_plan.md#gate-7](./project_plan.md#gate-7-book-candidate-grouping--evidence-merge) |
| 8 | **Hypothesis Generation** (NOT canonical) | [project_plan.md#gate-8](./project_plan.md#gate-8-hypothesis-generation) |
| 9 | **Resolver + Scoring + Verification** (Supabase Edge Function) | [project_plan.md#gate-9](./project_plan.md#gate-9-resolver--scoring--verification--acceptance) |
| 10 | Corrections Memory | [project_plan.md#gate-10](./project_plan.md#gate-10-corrections-memory) |

See [project_plan.md](./project_plan.md) for full details including:
- Problem statements
- Deliverables and file locations
- Data contracts (TypeScript interfaces)
- Algorithms and pseudocode
- UI changes
- Tests and validation commands
- Acceptance criteria
- Risks and mitigations

---

## Gate Status Template

Copy this to track progress:

```
Gate 0:  [ ] PASS / [ ] FAIL
Gate 1:  [ ] PASS / [ ] FAIL
Gate 2:  [ ] PASS / [ ] FAIL
Gate 3:  [ ] PASS / [ ] FAIL
Gate 4:  [ ] PASS / [ ] FAIL
Gate 5:  [ ] PASS / [ ] FAIL
Gate 6:  [ ] PASS / [ ] FAIL
Gate 7:  [ ] PASS / [ ] FAIL  (see project_plan.md)
Gate 8:  [ ] PASS / [ ] FAIL  (see project_plan.md)
Gate 9:  [ ] PASS / [ ] FAIL  (see project_plan.md)
Gate 10: [ ] PASS / [ ] FAIL  (see project_plan.md)
```

---

## Current Status (as of 2026-01-26)

| Gate | Status | Notes |
|------|--------|-------|
| 0 | PASS | Dataset validated |
| 1 | PASS | Model trained, mAP50 satisfactory |
| 2 | PASS | TFLite export successful |
| 3 | PASS | IO contract documented |
| 4 | PASS | Decode logic verified |
| 5 | PASS | End-to-end working on iOS |
| 6 | PASS | OCR working on iOS (Vision) and Android (ML Kit) |
| 7 | PASS | **Conservative grouping algorithm** - 19 tests passing |
| 8 | **PASS** | **Hypothesis Generation** (NOT canonical) - 92 tests (50 line labeling + 32 hypothesis + 10 display invariance) |
| 9 | **PASS** | **Resolver (Supabase Edge Function)** - concurrency cap, retry policy, 10 unit tests, feature-flagged ON |
| 10 | **PASS** | **Corrections Memory** - 34 unit tests, UI badges, revert button, diagnostic logging |

### Gate 7 Details

The grouping algorithm uses a **conservative-by-default** approach:
- **Only merges** on high IoU (≥0.50) for duplicates OR OCR-confirmed split-detection
- **Safety cap**: If any candidate would have >3 crops, falls back to 1:1 mapping
- **19 unit tests** covering all merge paths and edge cases
- **Debug artifact**: `grouping_assignments.json` written when enabled

### Gate 8 Details (Hypothesis Generation)

**IMPORTANT: Gate 8 output is NOT canonical.** It generates hypotheses for the resolver (Gate 9) to verify.

**UI DISPLAY ISOLATION:** Gate 8 hypothesis is resolver-input only; UI display uses legacy extraction (`evidence.perFieldHints` or OCR results) unless resolver output is accepted. Hypothesis fields are isolated under `candidate.hypothesis` sub-object and are NEVER used for display. Regression tests in `displayInvariance.test.ts` enforce this invariant.

Gate 8 has two parts:
1. **Line Labeling Pipeline** - for uiGuess generation
2. **Hypothesis Generation** - evidenceTier, searchCandidates, isbnCandidates, uiGuess

**Hypothesis Generation outputs:**
- `evidenceTier`: 'strong' | 'usable' | 'weak' | 'unusable'
- `searchCandidates`: queries for resolver lookup
- `isbnCandidates`: validated ISBNs for direct lookup
- `uiGuess`: title/author/confidence for immediate display (NOT canonical)

**Key Services:**
| Service | Purpose |
|---------|---------|
| `hypothesisGenerationService.ts` | Orchestrate Gate 8 hypothesis generation |
| `evidenceQualityService.ts` | Classify evidence tier |
| `spineLineFilter.ts` | Hard filter for ISBN, publisher, price, URL, copyright |
| `spineLineLabeler.ts` | Score lines for title vs author likelihood |
| `spineTitleAuthorAssembler.ts` | Assemble title/author from labeled lines |
| `spineSwapGuard.ts` | Detect and validate title/author swaps |

**Evidence Tier Rules:**
| Tier | Multiplier | Criteria |
|------|------------|----------|
| strong | 1.0 | avgConf ≥ 0.85, ≥3 lines, alnum ≥ 0.80 |
| usable | 0.85 | avgConf ≥ 0.70, ≥2 lines, alnum ≥ 0.65 |
| weak | 0.6 | avgConf ≥ 0.50, ≥1 line |
| unusable | 0 | Skip resolver call |

**Tests:**
- 50 line labeling tests in `gate8FieldExtraction.test.ts`
- 32 hypothesis generation tests in `hypothesisGenerationService.test.ts`
- 10 display invariance regression tests in `displayInvariance.test.ts`
**Total (Gate 8):** 92 tests

**Total Project Tests:** 587 tests passing

### Gate 9 Details (Resolver - Supabase Implementation)

**RESOLVER-CENTRIC**: Gate 9 provides CANONICAL truth via Supabase Edge Function.

The resolver:
1. Receives hypothesis from Gate 8 (searchCandidates, isbnCandidates, evidenceTier)
2. Checks resolver_cache (7-day TTL) to avoid duplicate API calls
3. Performs lookup against Open Library API (ISBN endpoint + search endpoint)
4. Scores matches using weighted signals and tier multipliers
5. Verifies matches and applies penalties for mismatches
6. Makes acceptance decisions: auto-accept/suggest/ambiguous/no-match
7. Returns canonical `ResolvedBook` to the app

**Implementation Files:**

| File | Purpose |
|------|---------|
| `supabase/migrations/20260123000001_resolver_tables.sql` | DB schema (resolver_cache, user_corrections, resolver_events) |
| `supabase/functions/resolve_candidates/index.ts` | Edge Function with rate limiting (30 req/min/IP) |
| `supabase/functions/_shared/types.ts` | Types, scoring weights, acceptance thresholds |
| `supabase/functions/_shared/utils.ts` | Scoring, verification, Open Library mapping |
| `src/config/supabase.ts` | Supabase client config with MMKV auth storage |
| `src/services/supabaseResolverClient.ts` | Client service (buildResolveRequest, resolveCandidate, applyResolverResult) |
| `src/services/offlineResolverQueue.ts` | MMKV offline queue with NetInfo auto-processing |
| `src/utils/evidenceHash.ts` | Evidence hash for cache keys |
| `scripts/evaluate_fixtures.ts` | Evaluation script for fixture testing |

**Scoring Weights:**
| Signal | Weight |
|--------|--------|
| titleSimilarity | 0.35 |
| authorPresence | 0.25 |
| isbnMatch | 0.25 |
| tokenCoverage | 0.10 |
| positionBonus | 0.05 |

**Acceptance Thresholds (by tier):**
| Tier | Threshold |
|------|-----------|
| strong | 0.72 |
| usable | 0.78 |
| weak | 0.88 |
| unusable | Skip resolver |

**Verification Flags:**
- `author-mismatch` (severity: warning, penalty: 0.10)
- `isbn-mismatch` (severity: critical, penalty: 0.30)
- `token-coverage-low` (severity: info, penalty: 0.05)

**Tests:** 20 unit tests in `supabaseResolverClient.test.ts`

**Feature Flag:** `METADATA_RESOLUTION_ENABLED` (default: OFF)

**To Enable:** Configure `src/config/supabase.ts` with your Supabase project URL and anon key, then set `METADATA_RESOLUTION_ENABLED = true` in `src/config/debug.ts`.

### Persistent Book Identity (books_catalog)

**Gate 9 Extension** - Canonical storage for resolved books with stable UUIDs.

When a book is auto-accepted or user-confirmed, it is upserted to `books_catalog` in Supabase. This provides:
- **Stable bookId**: Each unique book (by provider+provider_id) gets a persistent UUID
- **ISBN deduplication**: isbn13/isbn10 are unique-constrained
- **Corrections linking**: user_corrections.book_id references books_catalog.id

**When upsert happens:**
| Decision | Upsert? |
|----------|---------|
| auto-accept | ✓ Immediately (fire-and-forget) |
| suggest | ✗ Not until user confirms |
| ambiguous | ✗ Not until user confirms |
| no-match | ✗ Never |

**Implementation Files:**

| File | Purpose |
|------|---------|
| `supabase/migrations/20260127000001_books_catalog.sql` | DB schema + upsert_book RPC |
| `src/services/booksCatalogService.ts` | upsertResolvedBook, confirmUserSelection, applyUserSelectionToCandidate |
| `src/types/index.ts` | ResolvedBook.bookId field |
| `src/services/metadataResolutionOrchestrator.ts` | Auto-upsert on auto-accept |

**Key Functions:**
- `upsertResolvedBook(resolved)` - Upsert to books_catalog, returns { bookId }
- `confirmUserSelection(book, candidateId?)` - User confirms a suggestion
- `applyUserSelectionToCandidate(candidate, book)` - Apply + upsert in one call

**Database Schema (books_catalog):**
```sql
id UUID PRIMARY KEY (stable bookId)
provider TEXT ('openLibrary' | 'googleBooks')
provider_id TEXT (OLID, volumeId)
isbn13 TEXT UNIQUE
isbn10 TEXT UNIQUE
title TEXT
authors TEXT[]
publisher TEXT
publish_year TEXT
cover_url TEXT
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
UNIQUE (provider, provider_id)
```

**Tests:** 14 unit tests in `booksCatalogService.test.ts`

### Gate 10 Details (Corrections Memory)

**STATUS: PASS** - Full implementation complete.

Gate 10 remembers user corrections and auto-applies them on future scans of the same book.

**Implementation Files:**

| File | Purpose |
|------|---------|
| `src/types/index.ts` | `Correction`, `CorrectionKey`, `CorrectionApplyResult` types |
| `src/store/useCorrectionsStore.ts` | MMKV-backed Zustand store for corrections |
| `src/services/correctionsMemory.ts` | Core service (hash, find, apply, save, delete) |
| `src/utils/evidenceHash.ts` | Order-independent content hash (FNV-1a) |
| `src/components/BookCandidateCard.tsx` | "Auto" and "Edited" badge display |
| `src/components/EditCandidateFieldsModal.tsx` | Edit modal with "Revert to Auto-Detected" button |
| `src/screens/ResultsScreen.tsx` | UI integration, save/revert handlers |
| `src/config/debug.ts` | `isDiagnosticLoggingEnabled()` for corrections logging |

**Key Functions:**
- `generateContentHash(evidence)` - Creates stable, order-independent hash from OCR evidence
- `getCorrectionKey(candidate)` - Returns `isbn:X` or `hash:Y` key
- `findCorrection(candidate)` - Looks up stored correction
- `applyCorrection(candidate)` - Applies correction to candidate
- `saveCorrection(candidate, title, author)` - Saves user correction
- `deleteCorrection(candidate)` - Reverts to auto-detected values

**Order-Independence Guarantee:**
Same OCR lines in different orders produce identical hashes because:
1. Lines are sorted alphabetically before hashing
2. Per-field hints are also sorted
3. Uses shared `computeEvidenceHash` utility

**Matching Priority:**
1. ISBN (most reliable)
2. Content hash (fallback)

**Storage:**
- MMKV-backed with 500 correction limit
- LRU eviction when limit exceeded
- Corrections persist across app sessions

**UI Features:**
- "Auto" badge on candidates with auto-applied corrections
- "Edited" badge on manually edited candidates
- "Revert to Auto-Detected" button in edit modal

**Diagnostic Logging:**
When `DEBUG_ARTIFACTS_ENABLED = true` or `METADATA_VERBOSE_DEBUG = true`:
- Logs correction key, matched status, title/author for each apply attempt

**Tests:** 34 unit tests in `correctionsMemory.test.ts`
- Order-independence test verifies same lines in different order produce identical hash
- Persistence tests via mock MMKV
- Apply/save/revert flow tests

**Completed:**
- [x] Core services (save, find, apply, delete)
- [x] MMKV persistence with LRU eviction
- [x] Order-independent content hash
- [x] UI indicator for "Edited" corrections
- [x] UI indicator for "Auto-applied" corrections
- [x] "Revert to auto" button in edit modal
- [x] Diagnostic logging
- [x] Integration with pipeline (Stage 10)

---

## Notes

- Do NOT proceed past a failed gate
- Document the failure artifact (screenshot, log, JSON)
- Fix the root cause before retrying
- No "close enough" - gates are binary
- Gates 7-10 must be implemented sequentially (see [execution strategy](./project_plan.md#execution-strategy))
