#!/usr/bin/env python3
"""Decode TFLite model output with thresholding and NMS."""

import argparse
import glob
import json
import os
import random
import sys
import numpy as np


def _run_iou_sanity_tests():
    """Run sanity tests for polygon IoU. Raises AssertionError if failed."""
    # Test 1: Identical boxes => IoU ~ 1.0
    box = [100, 100, 50, 20, 0]  # cx, cy, w, h, angle
    iou = obb_iou(box, box)
    assert abs(iou - 1.0) < 0.01, f"Identical boxes IoU={iou}, expected ~1.0"

    # Test 2: Non-overlapping boxes => IoU = 0
    box1 = [0, 0, 10, 10, 0]
    box2 = [100, 100, 10, 10, 0]
    iou = obb_iou(box1, box2)
    assert iou == 0.0, f"Non-overlapping boxes IoU={iou}, expected 0.0"

    # Test 3: 50% horizontal overlap => IoU ~ 0.33
    box1 = [0, 0, 10, 10, 0]
    box2 = [5, 0, 10, 10, 0]  # shifted by half width
    iou = obb_iou(box1, box2)
    # Intersection = 5*10=50, Union = 100+100-50=150, IoU = 50/150 = 0.333
    assert 0.30 < iou < 0.36, f"50% overlap IoU={iou}, expected ~0.33"

    # Test 4: Rotated identical boxes => IoU ~ 1.0
    box1 = [100, 100, 50, 20, 0.5]
    box2 = [100, 100, 50, 20, 0.5]
    iou = obb_iou(box1, box2)
    assert abs(iou - 1.0) < 0.01, f"Rotated identical boxes IoU={iou}, expected ~1.0"


def compute_nms_debug_stats(boxes, scores, topk=300):
    """Compute IoU stats on pre-NMS candidates for debugging.

    Args:
        boxes: Nx5 array [cx, cy, w, h, angle]
        scores: N array of confidence scores
        topk: number of top candidates to analyze

    Returns:
        dict with IoU stats
    """
    n = len(scores)
    if n == 0:
        return {"error": "no boxes"}

    # Sort by score and take topk
    order = np.argsort(-scores)[:topk]
    boxes_top = boxes[order]
    scores_top = scores[order]

    # Sample random pairs (up to 500)
    num_pairs = min(500, len(order) * (len(order) - 1) // 2)
    random.seed(42)
    ious_random = []
    indices = list(range(len(order)))
    for _ in range(num_pairs):
        i, j = random.sample(indices, 2)
        iou = obb_iou(boxes_top[i], boxes_top[j])
        ious_random.append(iou)

    ious_random = np.array(ious_random)

    # IoU between top-1 and next top-20
    ious_top1 = []
    if len(boxes_top) > 1:
        top1 = boxes_top[0]
        for i in range(1, min(21, len(boxes_top))):
            iou = obb_iou(top1, boxes_top[i])
            ious_top1.append(iou)

    return {
        "num_candidates": len(order),
        "random_pairs": len(ious_random),
        "max_iou": float(ious_random.max()) if len(ious_random) > 0 else 0,
        "p99_iou": float(np.percentile(ious_random, 99)) if len(ious_random) > 0 else 0,
        "p95_iou": float(np.percentile(ious_random, 95)) if len(ious_random) > 0 else 0,
        "p50_iou": float(np.percentile(ious_random, 50)) if len(ious_random) > 0 else 0,
        "nonzero_pairs": int(np.sum(ious_random > 0)),
        "top1_vs_next20_max": float(max(ious_top1)) if ious_top1 else 0,
        "top1_vs_next20_ious": [round(x, 4) for x in ious_top1],
    }

def canonicalize_obb(w, h, angle):
    """Canonicalize OBB: ensure w >= h, angle in [-pi/2, pi/2].

    If w < h, swap dimensions and rotate by pi/2.
    Then normalize angle to [-pi/2, pi/2].
    """
    if w < h:
        w, h = h, w
        angle = angle + np.pi / 2

    # Normalize angle to [-pi/2, pi/2]
    while angle > np.pi / 2:
        angle -= np.pi
    while angle < -np.pi / 2:
        angle += np.pi

    return w, h, angle


def rotate_point(x, y, angle):
    """Rotate point (x, y) by angle (radians) around origin."""
    cos_a = np.cos(angle)
    sin_a = np.sin(angle)
    return x * cos_a - y * sin_a, x * sin_a + y * cos_a


def get_obb_corners(cx, cy, w, h, angle):
    """Compute 4 corners of rotated bounding box.
    Returns list of (x, y) tuples in order: TL, TR, BR, BL.
    """
    hw, hh = w / 2, h / 2
    offsets = [(-hw, -hh), (+hw, -hh), (+hw, +hh), (-hw, +hh)]
    corners = []
    for ox, oy in offsets:
        rx, ry = rotate_point(ox, oy, angle)
        corners.append((cx + rx, cy + ry))
    return corners


def polygon_area(vertices):
    """Compute area of polygon using shoelace formula.
    vertices: list of (x, y) tuples.
    """
    n = len(vertices)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += vertices[i][0] * vertices[j][1]
        area -= vertices[j][0] * vertices[i][1]
    return abs(area) / 2.0


def line_intersection(p1, p2, p3, p4):
    """Find intersection point of line p1-p2 with line p3-p4.
    Returns (x, y) or None if parallel.
    """
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-10:
        return None

    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    x = x1 + t * (x2 - x1)
    y = y1 + t * (y2 - y1)
    return (x, y)


def point_on_left(point, edge_start, edge_end):
    """Check if point is on left side of directed edge (or on the edge)."""
    x, y = point
    x1, y1 = edge_start
    x2, y2 = edge_end
    return (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) >= -1e-10


def sutherland_hodgman_clip(subject, clip):
    """Clip subject polygon against clip polygon using Sutherland-Hodgman.
    Both polygons are lists of (x, y) tuples in CCW order.
    Returns clipped polygon vertices.
    """
    if len(subject) < 3 or len(clip) < 3:
        return []

    output = list(subject)

    for i in range(len(clip)):
        if len(output) == 0:
            return []

        edge_start = clip[i]
        edge_end = clip[(i + 1) % len(clip)]

        input_list = output
        output = []

        for j in range(len(input_list)):
            current = input_list[j]
            previous = input_list[j - 1]

            current_inside = point_on_left(current, edge_start, edge_end)
            previous_inside = point_on_left(previous, edge_start, edge_end)

            if current_inside:
                if not previous_inside:
                    intersection = line_intersection(previous, current, edge_start, edge_end)
                    if intersection:
                        output.append(intersection)
                output.append(current)
            elif previous_inside:
                intersection = line_intersection(previous, current, edge_start, edge_end)
                if intersection:
                    output.append(intersection)

    return output


def ensure_ccw(vertices):
    """Ensure vertices are in counter-clockwise order."""
    n = len(vertices)
    if n < 3:
        return vertices
    # Compute signed area
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += vertices[i][0] * vertices[j][1]
        area -= vertices[j][0] * vertices[i][1]
    if area < 0:  # Clockwise, reverse
        return list(reversed(vertices))
    return vertices


def polygon_iou(poly_a, poly_b):
    """Compute IoU between two convex polygons.
    poly_a, poly_b: lists of (x, y) tuples.
    """
    area_a = polygon_area(poly_a)
    area_b = polygon_area(poly_b)

    if area_a <= 0 or area_b <= 0:
        return 0.0

    # Ensure CCW order for clipping
    poly_a_ccw = ensure_ccw(poly_a)
    poly_b_ccw = ensure_ccw(poly_b)

    # Clip poly_a against poly_b to get intersection
    intersection = sutherland_hodgman_clip(poly_a_ccw, poly_b_ccw)
    inter_area = polygon_area(intersection)

    union = area_a + area_b - inter_area
    if union <= 0:
        return 0.0
    return inter_area / union


def obb_iou(box_a, box_b):
    """Compute IoU between two OBBs.
    Each box is [cx, cy, w, h, angle].
    """
    corners_a = get_obb_corners(box_a[0], box_a[1], box_a[2], box_a[3], box_a[4])
    corners_b = get_obb_corners(box_b[0], box_b[1], box_b[2], box_b[3], box_b[4])
    return polygon_iou(corners_a, corners_b)


def nms_rotated(boxes, scores, iou_threshold, topk):
    """Apply greedy NMS using rotated bounding box IoU.
    boxes: Nx5 array of [cx, cy, w, h, angle]
    scores: N array of confidence scores
    Returns indices of kept boxes.
    """
    if len(scores) == 0:
        return []

    # Sort by score descending
    order = np.argsort(-scores)
    if topk > 0:
        order = order[:topk]

    keep = []
    suppressed = set()

    for idx in order:
        if idx in suppressed:
            continue
        keep.append(idx)
        for other_idx in order:
            if other_idx in suppressed or other_idx == idx:
                continue
            iou = obb_iou(boxes[idx], boxes[other_idx])
            if iou > iou_threshold:
                suppressed.add(other_idx)

    return keep


def aabb_iou(box_a, box_b):
    """Compute IoU between two axis-aligned bounding boxes.
    Each box is [cx, cy, w, h] (angle ignored).
    """
    ax1 = box_a[0] - box_a[2] / 2
    ay1 = box_a[1] - box_a[3] / 2
    ax2 = box_a[0] + box_a[2] / 2
    ay2 = box_a[1] + box_a[3] / 2

    bx1 = box_b[0] - box_b[2] / 2
    by1 = box_b[1] - box_b[3] / 2
    bx2 = box_b[0] + box_b[2] / 2
    by2 = box_b[1] + box_b[3] / 2

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih

    area_a = box_a[2] * box_a[3]
    area_b = box_b[2] * box_b[3]
    union = area_a + area_b - inter

    if union <= 0:
        return 0.0
    return inter / union


def nms_aabb(boxes, scores, iou_threshold, topk):
    """Apply greedy NMS using axis-aligned bounding boxes (ignores angle).
    boxes: Nx4 or Nx5 array of [cx, cy, w, h, (angle)]
    scores: N array of confidence scores
    Returns indices of kept boxes.
    """
    if len(scores) == 0:
        return []

    # Sort by score descending
    order = np.argsort(-scores)
    if topk > 0:
        order = order[:topk]

    keep = []
    suppressed = set()

    for idx in order:
        if idx in suppressed:
            continue
        keep.append(idx)
        for other_idx in order:
            if other_idx in suppressed or other_idx == idx:
                continue
            iou = aabb_iou(boxes[idx], boxes[other_idx])
            if iou > iou_threshold:
                suppressed.add(other_idx)

    return keep


def nms_soft_rotated(boxes, scores, iou_threshold, sigma=0.5, score_thr=0.001, topk=300):
    """Apply Gaussian soft-NMS using rotated bounding box IoU.
    Instead of hard suppression, decay overlapping scores by exp(-IoU^2/sigma).
    boxes: Nx5 array of [cx, cy, w, h, angle]
    scores: N array of confidence scores
    Returns indices of kept boxes.
    """
    if len(scores) == 0:
        return []

    order = np.argsort(-scores)
    if topk > 0:
        order = order[:topk]

    scores_work = scores.copy().astype(np.float64)
    keep = []

    for _ in range(len(order)):
        # Find current max score among remaining candidates
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
        # Decay overlapping scores
        for idx in order:
            if scores_work[idx] <= 0:
                continue
            iou = obb_iou(boxes[best], boxes[idx])
            scores_work[idx] *= np.exp(-(iou ** 2) / sigma)
            if scores_work[idx] < score_thr:
                scores_work[idx] = 0

    return keep


def check_dataset_classes():
    """Check dataset YAML for class count and warn if multi-class."""
    patterns = [
        "ml/datasets/open_shelves/data.yaml",
        "ml/datasets/open_shelves/**/data.yaml",
        "ml/datasets/**/data.yaml",
    ]
    yaml_files = []
    for pattern in patterns:
        yaml_files.extend(glob.glob(pattern, recursive=True))

    if not yaml_files:
        return

    yaml_path = yaml_files[0]
    try:
        with open(yaml_path, "r") as f:
            content = f.read()
    except Exception:
        return

    # Parse nc value from YAML (no pyyaml dependency)
    num_classes = 0
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("nc:"):
            try:
                num_classes = int(line.split(":")[1].strip())
                break
            except ValueError:
                pass

    if num_classes > 1:
        print("=" * 60)
        print("WARNING: Dataset has {} classes but model output has".format(num_classes))
        print("features=6 (cx,cy,w,h,angle,score) with NO class dimension.")
        print("Training was single-class. If multi-class is needed,")
        print("retrain model or fix detection head.")
        print("Dataset YAML: {}".format(yaml_path))
        print("=" * 60)

def main():
    import time

    # Preset configurations (synced with inferenceService.ts)
    PRESETS = {
        "spine": {
            "thr": 0.45,
            "nms_iou": 0.35,
            "nms_mode": "obb",
            "nms_method": "hard",
            "topk": 300,
            "min_aspect": 2.5,
            "max_area_ratio": 0.40,
            "min_score": 0.45,
        },
        "general": {
            "thr": 0.40,
            "nms_iou": 0.50,
            "nms_mode": "obb",
            "nms_method": "hard",
            "soft_sigma": 0.5,
            "topk": 300,
            "min_aspect": 1.0,
            "max_area_ratio": 0.50,
            "min_score": 0.40,
        },
    }

    parser = argparse.ArgumentParser(description="Decode TFLite OBB output")
    parser.add_argument("--preset", choices=["spine", "general"], default="spine",
                        help="Preset configuration (default: spine)")
    parser.add_argument("--thr", type=float, help="Confidence threshold (spine: 0.50)")
    parser.add_argument("--nms_iou", type=float, help="NMS IoU threshold (spine: 0.90)")
    parser.add_argument("--nms_mode", choices=["obb", "aabb"], help="NMS mode (spine: obb)")
    parser.add_argument("--nms_method", choices=["hard", "soft"], help="NMS method (spine: soft)")
    parser.add_argument("--soft_sigma", type=float, help="Sigma for soft-NMS Gaussian decay (default: 0.5)")
    parser.add_argument("--nms_debug", action="store_true", help="Print IoU stats before NMS")
    parser.add_argument("--topk", type=int, help="Top-K candidates before NMS (default: 300)")
    parser.add_argument("--min_aspect", type=float, help="Min aspect ratio w/h (spine: 6.0)")
    parser.add_argument("--max_area_ratio", type=float, help="Max area ratio (spine: 0.08)")
    parser.add_argument("--min_score", type=float, help="Min score for filtering (spine: 0.60)")
    parser.add_argument("--profile", action="store_true", help="Print timing breakdown")
    args = parser.parse_args()

    # Apply preset defaults, then override with explicit args
    preset = PRESETS[args.preset]
    args.thr = args.thr if args.thr is not None else preset["thr"]
    args.nms_iou = args.nms_iou if args.nms_iou is not None else preset["nms_iou"]
    args.nms_mode = args.nms_mode if args.nms_mode is not None else preset["nms_mode"]
    args.nms_method = args.nms_method if args.nms_method is not None else preset.get("nms_method", "hard")
    args.soft_sigma = args.soft_sigma if args.soft_sigma is not None else preset.get("soft_sigma", 0.5)
    args.topk = args.topk if args.topk is not None else preset["topk"]
    args.min_aspect = args.min_aspect if args.min_aspect is not None else preset["min_aspect"]
    args.max_area_ratio = args.max_area_ratio if args.max_area_ratio is not None else preset["max_area_ratio"]
    args.min_score = args.min_score if args.min_score is not None else preset["min_score"]

    # Timing dict
    timings = {}

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

    model_path = "src/models/yolov8_obb.tflite"
    raw_path = "debug/detections_raw.json"
    out_path = "debug/debug_manifest.json"

    if not os.path.exists(model_path):
        print(f"ERROR: Model not found: {model_path}")
        sys.exit(1)

    if not os.path.exists(raw_path):
        print(f"ERROR: Raw detections not found: {raw_path}")
        print("Run: python3 tools/run_one_tflite.py first")
        sys.exit(1)

    # Check dataset class count
    check_dataset_classes()

    t_total_start = time.time()

    with open(raw_path, "r") as f:
        raw = json.load(f)
    image_file = raw["image_file"]

    # Preprocess
    t_preprocess_start = time.time()
    img0 = Image.open(image_file).convert("RGB")
    orig_w, orig_h = img0.size

    img = img0.resize((640, 640), Image.BILINEAR)
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = np.expand_dims(x, 0)
    timings["preprocess"] = time.time() - t_preprocess_start

    print(f"Image: {image_file}")
    print(f"Original size: {orig_w}x{orig_h}")
    print(f"Preset: {args.preset}")
    print(f"Threshold: {args.thr}")
    print(f"NMS IoU: {args.nms_iou}")
    print(f"NMS mode: {args.nms_mode}")
    print(f"NMS method: {args.nms_method}")
    if args.nms_method == "soft":
        print(f"Soft-NMS sigma: {args.soft_sigma}")
    print(f"Top-K: {args.topk}")
    print(f"Min aspect ratio: {args.min_aspect}")
    print(f"Max area ratio: {args.max_area_ratio}")
    print(f"Min score (filter): {args.min_score}")

    # Inference
    t_inference_start = time.time()
    interpreter = tf.lite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

    input_details = interpreter.get_input_details()[0]
    interpreter.set_tensor(input_details["index"], x)
    interpreter.invoke()

    output_details = interpreter.get_output_details()[0]
    y = interpreter.get_tensor(output_details["index"])  # [1, 6, 8400]
    timings["inference"] = time.time() - t_inference_start

    if list(y.shape) != [1, 6, 8400]:
        print(f"ERROR: Unexpected output shape: {y.shape}")
        sys.exit(1)

    # Decode + Canonicalize
    t_decode_start = time.time()

    y = y[0]  # [6, 8400]
    y = y.T   # [8400, 6]

    num_raw = y.shape[0]

    cx = y[:, 0]
    cy = y[:, 1]
    w = y[:, 2]
    h = y[:, 3]
    score = y[:, 4]
    angle = y[:, 5]

    # Apply confidence threshold
    keep_mask = score >= args.thr
    cx_thr = cx[keep_mask]
    cy_thr = cy[keep_mask]
    w_thr = w[keep_mask]
    h_thr = h[keep_mask]
    angle_thr = angle[keep_mask]
    score_thr = score[keep_mask]

    num_before_nms = len(score_thr)
    print(f"After threshold: {num_before_nms} detections")

    # Canonicalize OBB parameters (w >= h, angle in [-pi/2, pi/2])
    for i in range(len(w_thr)):
        w_thr[i], h_thr[i], angle_thr[i] = canonicalize_obb(w_thr[i], h_thr[i], angle_thr[i])

    timings["decode_canonicalize"] = time.time() - t_decode_start

    # Apply NMS based on mode
    boxes = np.stack([cx_thr, cy_thr, w_thr, h_thr, angle_thr], axis=1)

    # NMS debug mode: compute IoU stats before NMS
    if args.nms_debug:
        print("\n=== NMS DEBUG: Pre-NMS IoU Stats ===")
        # Run sanity tests first
        try:
            _run_iou_sanity_tests()
            print("Sanity tests: PASSED")
        except AssertionError as e:
            print(f"Sanity tests: FAILED - {e}")
            sys.exit(1)

        stats = compute_nms_debug_stats(boxes, score_thr, args.topk)
        print(f"Candidates: {stats['num_candidates']}")
        print(f"Random pairs sampled: {stats['random_pairs']}")
        print(f"Max IoU: {stats['max_iou']:.4f}")
        print(f"P99 IoU: {stats['p99_iou']:.4f}")
        print(f"P95 IoU: {stats['p95_iou']:.4f}")
        print(f"P50 IoU: {stats['p50_iou']:.4f}")
        print(f"Non-zero pairs: {stats['nonzero_pairs']}")
        print(f"Top-1 vs next-20 max IoU: {stats['top1_vs_next20_max']:.4f}")
        print(f"Top-1 vs next-20 IoUs: {stats['top1_vs_next20_ious']}")
        print("=" * 40)

    # NMS
    t_nms_start = time.time()
    if args.nms_method == "soft":
        nms_indices = nms_soft_rotated(boxes, score_thr, args.nms_iou,
                                       sigma=args.soft_sigma, topk=args.topk)
    elif args.nms_mode == "obb":
        nms_indices = nms_rotated(boxes, score_thr, args.nms_iou, args.topk)
    else:  # aabb
        nms_indices = nms_aabb(boxes, score_thr, args.nms_iou, args.topk)
    timings["nms"] = time.time() - t_nms_start

    cx_nms = cx_thr[nms_indices]
    cy_nms = cy_thr[nms_indices]
    w_nms = w_thr[nms_indices]
    h_nms = h_thr[nms_indices]
    angle_nms = angle_thr[nms_indices]
    score_nms = score_thr[nms_indices]

    num_after_nms = len(score_nms)
    print(f"After NMS: {num_after_nms} detections")

    # Map to original image coordinates (naive resize, no letterbox)
    sx = orig_w / 640.0
    sy = orig_h / 640.0

    detections = []
    for i in range(num_after_nms):
        detections.append({
            "cx": float(cx_nms[i] * sx),
            "cy": float(cy_nms[i] * sy),
            "w": float(w_nms[i] * sx),
            "h": float(h_nms[i] * sy),
            "angle": float(angle_nms[i]),
            "score": float(score_nms[i]),
            "classId": 0
        })

    # Geometric filters
    t_geom_start = time.time()
    image_area = orig_w * orig_h
    detections_filtered = []
    for det in detections:
        w_det = det["w"]
        h_det = det["h"]
        score = det["score"]

        # Aspect ratio filter (w >= h after canonicalization, so w/h is aspect ratio)
        aspect_ratio = w_det / h_det if h_det > 0 else 0
        if aspect_ratio < args.min_aspect:
            continue

        # Area ratio filter
        det_area = w_det * h_det
        area_ratio = det_area / image_area if image_area > 0 else 0
        if area_ratio > args.max_area_ratio:
            continue

        # Minimum score filter
        if score < args.min_score:
            continue

        detections_filtered.append(det)

    timings["geom_filters"] = time.time() - t_geom_start
    timings["total"] = time.time() - t_total_start

    num_after_geom = len(detections_filtered)
    print(f"After geometric filters: {num_after_geom} detections")

    payload = {
        "image_file": image_file,
        "imageWidth": orig_w,
        "imageHeight": orig_h,
        "preset": args.preset,
        "thr": args.thr,
        "nms_iou": args.nms_iou,
        "nms_mode": args.nms_mode,
        "nms_method": args.nms_method,
        "soft_sigma": args.soft_sigma if args.nms_method == "soft" else None,
        "topk": args.topk,
        "min_aspect": args.min_aspect,
        "max_area_ratio": args.max_area_ratio,
        "min_score": args.min_score,
        "canonicalization_applied": True,
        "angle_range": "[-pi/2, pi/2]",
        "num_raw": num_raw,
        "num_after_thr": num_before_nms,
        "num_after_nms": num_after_nms,
        "num_after_geom": num_after_geom,
        "timings_ms": {k: round(v * 1000, 2) for k, v in timings.items()},
        "detectionsOriginal": detections,
        "detectionsFiltered": detections_filtered
    }

    os.makedirs("debug", exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote: {out_path}")

    # Print pipeline summary report
    print("\n" + "=" * 50)
    print("DETECTION PIPELINE SUMMARY")
    print("=" * 50)
    print(f"  Raw detections:           {num_raw}")
    print(f"  After threshold (>{args.thr}):  {num_before_nms}")
    print(f"  After NMS ({args.nms_method}/{args.nms_mode}):    {num_after_nms}")
    print(f"  After geometric filters:  {num_after_geom}")
    print("=" * 50)

    if detections_filtered:
        print(f"\nTop 5 filtered detections:")
        for d in detections_filtered[:5]:
            aspect = d['w'] / d['h'] if d['h'] > 0 else 0
            print(f"  score={d['score']:.3f} w={d['w']:.1f} h={d['h']:.1f} aspect={aspect:.1f} angle={d['angle']:.3f}")

    # Print timing profile if requested
    if args.profile:
        print("\n" + "=" * 50)
        print("TIMING PROFILE (ms)")
        print("=" * 50)
        print(f"  Preprocess:          {timings['preprocess']*1000:7.2f}")
        print(f"  Inference:           {timings['inference']*1000:7.2f}")
        print(f"  Decode+Canonicalize: {timings['decode_canonicalize']*1000:7.2f}")
        print(f"  NMS ({args.nms_method}/{args.nms_mode}):      {timings['nms']*1000:7.2f}")
        print(f"  Geometric filters:   {timings['geom_filters']*1000:7.2f}")
        print(f"  ---")
        print(f"  Total:               {timings['total']*1000:7.2f}")
        print("=" * 50)

        # Warn if NMS is slow (> 100ms for spine preset could affect UX)
        if timings['nms'] > 0.1 and (args.nms_mode == "obb" or args.nms_method == "soft"):
            print("\nWARNING: NMS took >100ms. Consider using --nms_method hard --nms_mode aabb")
            print("         for device builds if latency is critical.")

if __name__ == "__main__":
    main()
