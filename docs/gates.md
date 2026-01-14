# Stop-the-Line Gates

Hard pass/fail checklist. Each gate must pass before proceeding to the next.

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
- [ ] Rectified crops show upright text

**Verify:**
```bash
# Manual device test - check Documents/sessions/*/debug_manifest.json
```

**Fail action:** Check coordinate mapping, angle convention, screen mapping.

---

## Gate Status Template

Copy this to track progress:

```
Gate 0: [ ] PASS / [ ] FAIL
Gate 1: [ ] PASS / [ ] FAIL
Gate 2: [ ] PASS / [ ] FAIL
Gate 3: [ ] PASS / [ ] FAIL
Gate 4: [ ] PASS / [ ] FAIL
Gate 5: [ ] PASS / [ ] FAIL
```

---

## Notes

- Do NOT proceed past a failed gate
- Document the failure artifact (screenshot, log, JSON)
- Fix the root cause before retrying
- No "close enough" - gates are binary
