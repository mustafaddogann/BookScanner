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

Gates 7-10 cover advanced metadata extraction and are documented separately:

| Gate | Description | Documentation |
|------|-------------|---------------|
| 7 | Book Candidate Grouping + Evidence Merge | [project_plan.md#gate-7](./project_plan.md#gate-7-book-candidate-grouping--evidence-merge) |
| 8 | Field Extraction with Ranked Candidates | [project_plan.md#gate-8](./project_plan.md#gate-8-field-extraction-with-ranked-candidates) |
| 9 | Resolver (External Lookup) | [project_plan.md#gate-9](./project_plan.md#gate-9-resolver-external-lookup) |
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

## Current Status (as of 2026-01-23)

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
| 8 | **PASS** | **Line labeling pipeline** - 50 tests passing |
| 9 | IN PROGRESS | Metadata resolution services implemented (feature-flagged OFF) |
| 10 | NOT STARTED | Corrections memory |

### Gate 7 Details

The grouping algorithm uses a **conservative-by-default** approach:
- **Only merges** on high IoU (≥0.50) for duplicates OR OCR-confirmed split-detection
- **Safety cap**: If any candidate would have >3 crops, falls back to 1:1 mapping
- **19 unit tests** covering all merge paths and edge cases
- **Debug artifact**: `grouping_assignments.json` written when enabled

### Gate 8 Details

Field extraction uses a **line labeling pipeline** for accurate title/author extraction:

**Pipeline:** `Filter → Label → Assemble → Validate`

**Key Services:**
| Service | Purpose |
|---------|---------|
| `spineLineFilter.ts` | Hard filter for ISBN, publisher, price, URL, copyright |
| `spineLineLabeler.ts` | Score lines for title vs author likelihood |
| `spineTitleAuthorAssembler.ts` | Assemble title/author from labeled lines |
| `spineSwapGuard.ts` | Detect and validate title/author swaps |
| `mixedOrientationMerger.ts` | Merge multi-rotation OCR evidence |

**Key Features:**
- **Context-aware publisher filtering**: Filters "Thomas" when "Books" nearby
- **Multi-line author joining**: "Laura" + "Bates" → "Laura Bates"
- **Subtitle preservation**: "Title: Subtitle" stays together
- **Combined line splitting**: "Author • Title" patterns correctly split
- **Swap detection**: Validates and flags potential swaps
- **Multi-rotation support**: Preserves evidence from multiple rotation trials

**Tests:** 50 comprehensive tests in `gate8FieldExtraction.test.ts`
**Total:** 474 tests passing

### Gate 9 Details

Metadata resolution services are implemented but feature-flagged OFF:
- `searchCandidateService.ts` - Generate search candidates from evidence
- `matchVerificationService.ts` - Verify matches with evidence
- `acceptanceDecisionService.ts` - Make acceptance decisions
- `spineFieldExtractionService.ts` - Orchestrates Gate 8 pipeline for field extraction

---

## Notes

- Do NOT proceed past a failed gate
- Document the failure artifact (screenshot, log, JSON)
- Fix the root cause before retrying
- No "close enough" - gates are binary
- Gates 7-10 must be implemented sequentially (see [execution strategy](./project_plan.md#execution-strategy))
