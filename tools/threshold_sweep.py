#!/usr/bin/env python3
"""Sweep (conf, nmsIou, minAspect, nmsMethod) on the validation set and report P/R/F1.

Reuses geometry helpers from decode_one.py.
Outputs:
  - debug/threshold_sweep.csv   (one row per param combo)
  - console summary of best params
  - debug/threshold_sweep_best.json
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from itertools import product
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Import geometry helpers from decode_one.py
# ---------------------------------------------------------------------------
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)

from decode_one import (
    canonicalize_obb,
    get_obb_corners,
    obb_iou,
    polygon_iou,
)


# ---------------------------------------------------------------------------
# NMS helpers (hard + soft)
# ---------------------------------------------------------------------------

def nms_rotated_hard(boxes, scores, iou_thr, topk=300):
    """Greedy hard NMS on OBBs. Returns indices of kept boxes."""
    if len(scores) == 0:
        return []
    order = np.argsort(-scores)
    if topk > 0:
        order = order[:topk]
    keep = []
    suppressed = set()
    for idx in order:
        if idx in suppressed:
            continue
        keep.append(idx)
        for other in order:
            if other in suppressed or other == idx:
                continue
            if obb_iou(boxes[idx], boxes[other]) > iou_thr:
                suppressed.add(other)
    return keep


def nms_rotated_soft(boxes, scores, iou_thr, sigma=0.5, score_thr=0.001, topk=300):
    """Gaussian soft-NMS on OBBs. Returns (indices, updated_scores)."""
    if len(scores) == 0:
        return [], np.array([])
    order = np.argsort(-scores)
    if topk > 0:
        order = order[:topk]
    scores_work = scores.copy().astype(np.float64)
    keep = []
    for i in range(len(order)):
        # Find current max
        best = -1
        best_score = -1.0
        for idx in order:
            if scores_work[idx] > best_score:
                best_score = scores_work[idx]
                best = idx
        if best < 0 or best_score < score_thr:
            break
        keep.append(best)
        scores_work[best] = 0  # remove from future consideration
        for idx in order:
            if scores_work[idx] <= 0:
                continue
            iou = obb_iou(boxes[best], boxes[idx])
            scores_work[idx] *= np.exp(-(iou ** 2) / sigma)
            if scores_work[idx] < score_thr:
                scores_work[idx] = 0
    return keep, scores[keep] if len(keep) > 0 else np.array([])


# ---------------------------------------------------------------------------
# Ground-truth loader (YOLO OBB 8-point format)
# ---------------------------------------------------------------------------

def load_gt_labels(label_path, img_w, img_h):
    """Load YOLO OBB labels (class x1 y1 x2 y2 x3 y3 x4 y4) → list of [cx,cy,w,h,angle].

    Coordinates in label file are normalized [0,1]. We convert to model-space (640x640).
    """
    boxes = []
    if not os.path.exists(label_path):
        return boxes
    with open(label_path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 9:
                continue
            # class + 4 corner points (x1 y1 x2 y2 x3 y3 x4 y4) – normalized
            coords = [float(p) for p in parts[1:9]]
            xs = [coords[i] * img_w for i in range(0, 8, 2)]
            ys = [coords[i] * img_h for i in range(1, 8, 2)]
            cx = np.mean(xs)
            cy = np.mean(ys)
            # Fit minimum-area OBB via PCA-like approach on corners
            pts = np.array(list(zip(xs, ys)))
            # Edge vectors (use first two edges to get angle)
            edge0 = pts[1] - pts[0]
            angle = np.arctan2(edge0[1], edge0[0])
            # Rotate corners by -angle to get axis-aligned dims
            cos_a = np.cos(-angle)
            sin_a = np.sin(-angle)
            rotated = np.zeros_like(pts)
            for i, (px, py) in enumerate(pts):
                dx, dy = px - cx, py - cy
                rotated[i, 0] = dx * cos_a - dy * sin_a
                rotated[i, 1] = dx * sin_a + dy * cos_a
            w = rotated[:, 0].max() - rotated[:, 0].min()
            h = rotated[:, 1].max() - rotated[:, 1].min()
            w, h, angle = canonicalize_obb(w, h, angle)
            boxes.append([cx, cy, w, h, angle])
    return boxes


# ---------------------------------------------------------------------------
# Matching (greedy, IoU >= 0.5)
# ---------------------------------------------------------------------------

def match_predictions(preds, gts, iou_thr=0.5):
    """Greedy match predictions to ground-truth boxes.

    Returns (tp, fp, fn).
    """
    if len(preds) == 0:
        return 0, 0, len(gts)
    if len(gts) == 0:
        return 0, len(preds), 0

    matched_gt = set()
    tp = 0
    fp = 0
    # preds assumed sorted by score desc already
    for pred in preds:
        best_iou = 0.0
        best_gt = -1
        for gi, gt in enumerate(gts):
            if gi in matched_gt:
                continue
            iou = obb_iou(pred, gt)
            if iou > best_iou:
                best_iou = iou
                best_gt = gi
        if best_iou >= iou_thr and best_gt >= 0:
            tp += 1
            matched_gt.add(best_gt)
        else:
            fp += 1
    fn = len(gts) - len(matched_gt)
    return tp, fp, fn


# ---------------------------------------------------------------------------
# Main sweep
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Threshold sweep on validation set")
    parser.add_argument("--model", default="src/models/yolov8_obb.tflite",
                        help="Path to TFLite model")
    parser.add_argument("--val_images",
                        default="ml/datasets/open_shelves/valid/images",
                        help="Validation images directory")
    parser.add_argument("--val_labels",
                        default="ml/datasets/open_shelves/valid/labels",
                        help="Validation labels directory")
    parser.add_argument("--out_csv", default="debug/threshold_sweep.csv")
    parser.add_argument("--out_json", default="debug/threshold_sweep_best.json")
    parser.add_argument("--match_iou", type=float, default=0.5,
                        help="IoU threshold for GT matching")
    args = parser.parse_args()

    # Resolve paths relative to project root (BookScanner/)
    project_root = Path(TOOLS_DIR).parent
    model_path = project_root / args.model
    val_img_dir = project_root / args.val_images
    val_lbl_dir = project_root / args.val_labels
    out_csv = project_root / args.out_csv
    out_json = project_root / args.out_json

    if not model_path.exists():
        print(f"ERROR: Model not found: {model_path}")
        sys.exit(1)
    if not val_img_dir.exists():
        print(f"ERROR: Val images not found: {val_img_dir}")
        sys.exit(1)

    # Load TFLite model once
    try:
        import tensorflow as tf
    except ImportError:
        print("ERROR: tensorflow not installed. Run: pip install tensorflow")
        sys.exit(1)

    try:
        from PIL import Image
    except ImportError:
        print("ERROR: pillow not installed. Run: pip install pillow")
        sys.exit(1)

    print("Loading model...")
    interpreter = tf.lite.Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    MODEL_SIZE = 640

    # Enumerate validation images
    img_files = sorted([
        f for f in val_img_dir.iterdir()
        if f.suffix.lower() in ('.jpg', '.jpeg', '.png')
    ])
    print(f"Found {len(img_files)} validation images")

    # --- Run inference on all images ONCE (lowest threshold) ---
    # Store raw per-image decoded detections (before conf filter)
    print("Running inference on all images...")
    all_raw = []  # list of dict: {boxes: Nx5, scores: N, gts: Mx5}

    t_inf_start = time.time()
    for img_path in img_files:
        # Load & preprocess
        img = Image.open(img_path).convert("RGB")
        orig_w, orig_h = img.size
        img_resized = img.resize((MODEL_SIZE, MODEL_SIZE), Image.BILINEAR)
        x = np.asarray(img_resized, dtype=np.float32) / 255.0
        x = np.expand_dims(x, 0)

        # Inference
        interpreter.set_tensor(input_details["index"], x)
        interpreter.invoke()
        y = interpreter.get_tensor(output_details["index"])  # [1, 6, 8400]

        if y.shape[1] != 6 or y.shape[2] != 8400:
            print(f"WARNING: Unexpected shape {y.shape} for {img_path.name}, skipping")
            continue

        y = y[0].T  # [8400, 6]
        cx = y[:, 0]
        cy = y[:, 1]
        w_raw = y[:, 2]
        h_raw = y[:, 3]
        score = y[:, 4]
        angle = y[:, 5]

        # Canonicalize all
        w_can = w_raw.copy()
        h_can = h_raw.copy()
        a_can = angle.copy()
        for i in range(len(w_can)):
            w_can[i], h_can[i], a_can[i] = canonicalize_obb(w_can[i], h_can[i], a_can[i])

        boxes = np.stack([cx, cy, w_can, h_can, a_can], axis=1)

        # Load ground-truth (in model-space 640x640)
        lbl_path = val_lbl_dir / (img_path.stem + ".txt")
        gts = load_gt_labels(str(lbl_path), MODEL_SIZE, MODEL_SIZE)

        all_raw.append({
            "boxes": boxes,
            "scores": score,
            "gts": gts,
        })

    t_inf_end = time.time()
    print(f"Inference done in {t_inf_end - t_inf_start:.1f}s ({len(all_raw)} images)")

    # --- Define sweep grid ---
    THR_GRID = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]
    NMS_IOU_GRID = [0.35, 0.40, 0.45, 0.50, 0.55]
    MIN_ASPECT_GRID = [2.0, 2.5, 3.0]
    NMS_METHOD_GRID = ["hard", "soft"]

    combos = list(product(THR_GRID, NMS_IOU_GRID, MIN_ASPECT_GRID, NMS_METHOD_GRID))
    print(f"Sweep grid: {len(combos)} combinations")

    # --- Sweep ---
    results = []
    best_f1 = -1.0
    best_row = None

    os.makedirs(str(out_csv.parent), exist_ok=True)

    t_sweep_start = time.time()
    for ci, (thr, nms_iou, min_aspect, nms_method) in enumerate(combos):
        total_tp = 0
        total_fp = 0
        total_fn = 0

        for img_data in all_raw:
            boxes = img_data["boxes"]
            scores = img_data["scores"]
            gts = img_data["gts"]

            # 1. Confidence threshold
            mask = scores >= thr
            if not np.any(mask):
                total_fn += len(gts)
                continue

            b = boxes[mask]
            s = scores[mask]

            # 2. NMS
            if nms_method == "soft":
                keep_idx, _ = nms_rotated_soft(b, s, nms_iou, sigma=0.5, topk=300)
            else:
                keep_idx = nms_rotated_hard(b, s, nms_iou, topk=300)

            if len(keep_idx) == 0:
                total_fn += len(gts)
                continue

            b_nms = b[keep_idx]
            s_nms = s[keep_idx]

            # 3. Geometric filter: min aspect ratio + min score
            keep_geo = []
            for i in range(len(b_nms)):
                w_d, h_d = b_nms[i, 2], b_nms[i, 3]
                aspect = w_d / h_d if h_d > 0 else 0
                if aspect < min_aspect:
                    continue
                if s_nms[i] < thr:  # minScore = thr
                    continue
                keep_geo.append(i)

            if len(keep_geo) == 0:
                total_fn += len(gts)
                continue

            preds_final = [b_nms[i].tolist() for i in keep_geo]
            # Sort by score desc
            score_final = [float(s_nms[i]) for i in keep_geo]
            order = sorted(range(len(score_final)), key=lambda x: -score_final[x])
            preds_final = [preds_final[o] for o in order]

            tp, fp, fn = match_predictions(preds_final, gts, iou_thr=args.match_iou)
            total_tp += tp
            total_fp += fp
            total_fn += fn

        precision = total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0.0
        recall = total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

        row = {
            "thr": thr,
            "nms_iou": nms_iou,
            "min_aspect": min_aspect,
            "nms_method": nms_method,
            "tp": total_tp,
            "fp": total_fp,
            "fn": total_fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        }
        results.append(row)

        if f1 > best_f1:
            best_f1 = f1
            best_row = row

        if (ci + 1) % 50 == 0:
            print(f"  [{ci+1}/{len(combos)}] best F1 so far: {best_f1:.4f}")

    t_sweep_end = time.time()
    print(f"Sweep done in {t_sweep_end - t_sweep_start:.1f}s")

    # --- Write CSV ---
    fieldnames = ["thr", "nms_iou", "min_aspect", "nms_method",
                  "tp", "fp", "fn", "precision", "recall", "f1"]
    with open(str(out_csv), "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)
    print(f"\nWrote {len(results)} rows to {out_csv}")

    # --- Write best JSON ---
    best_payload = {
        "best": best_row,
        "grid": {
            "thr": THR_GRID,
            "nms_iou": NMS_IOU_GRID,
            "min_aspect": MIN_ASPECT_GRID,
            "nms_method": NMS_METHOD_GRID,
        },
        "num_images": len(all_raw),
        "match_iou": args.match_iou,
        "total_combos": len(combos),
    }
    with open(str(out_json), "w") as f:
        json.dump(best_payload, f, indent=2)
    print(f"Wrote best params to {out_json}")

    # --- Console summary ---
    print("\n" + "=" * 60)
    print("BEST PARAMETERS")
    print("=" * 60)
    print(f"  thr:         {best_row['thr']}")
    print(f"  nms_iou:     {best_row['nms_iou']}")
    print(f"  min_aspect:  {best_row['min_aspect']}")
    print(f"  nms_method:  {best_row['nms_method']}")
    print(f"  ---")
    print(f"  Precision:   {best_row['precision']:.4f}")
    print(f"  Recall:      {best_row['recall']:.4f}")
    print(f"  F1:          {best_row['f1']:.4f}")
    print(f"  TP={best_row['tp']}  FP={best_row['fp']}  FN={best_row['fn']}")
    print("=" * 60)

    # Top-10 by F1
    sorted_results = sorted(results, key=lambda r: -r["f1"])
    print("\nTop 10 combos by F1:")
    print(f"  {'thr':>5} {'nms_iou':>7} {'aspect':>6} {'method':>6}  {'P':>6} {'R':>6} {'F1':>6}")
    for r in sorted_results[:10]:
        print(f"  {r['thr']:5.2f} {r['nms_iou']:7.2f} {r['min_aspect']:6.1f} {r['nms_method']:>6}"
              f"  {r['precision']:6.4f} {r['recall']:6.4f} {r['f1']:6.4f}")


if __name__ == "__main__":
    main()
