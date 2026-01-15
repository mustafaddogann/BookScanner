#!/usr/bin/env python3
"""Render OBB detections as polygon overlays on the source image."""

import json
import os
import sys
import numpy as np

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
    # Corner offsets relative to center (before rotation)
    offsets = [
        (-hw, -hh),  # top-left
        (+hw, -hh),  # top-right
        (+hw, +hh),  # bottom-right
        (-hw, +hh),  # bottom-left
    ]
    corners = []
    for ox, oy in offsets:
        rx, ry = rotate_point(ox, oy, angle)
        corners.append((cx + rx, cy + ry))
    return corners

def load_font():
    """Try to load a small font for score labels."""
    try:
        from PIL import ImageFont
    except ImportError:
        return None

    try:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
    except Exception:
        try:
            return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
        except Exception:
            return ImageFont.load_default()


def render_detections(image_file, detections, output_path, title=""):
    """Render detections on image and save to output_path."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("ERROR: pillow not installed. Run: pip install pillow")
        return 0

    if not os.path.exists(image_file):
        print(f"ERROR: Image not found: {image_file}")
        return 0

    img = Image.open(image_file).convert("RGB")
    draw = ImageDraw.Draw(img)

    font = load_font()

    # Color palette for boxes
    colors = [
        "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
        "#FF8000", "#8000FF", "#00FF80", "#FF0080", "#80FF00", "#0080FF",
    ]

    num_drawn = 0
    for i, det in enumerate(detections):
        cx = det["cx"]
        cy = det["cy"]
        w = det["w"]
        h = det["h"]
        angle = det["angle"]
        score = det.get("score", 0)

        corners = get_obb_corners(cx, cy, w, h, angle)
        # Close the polygon
        polygon = corners + [corners[0]]
        flat_coords = [(int(x), int(y)) for x, y in polygon]

        color = colors[i % len(colors)]
        draw.line(flat_coords, fill=color, width=2)

        # Draw score label near top-left corner
        label = f"{score:.2f}"
        label_x = int(corners[0][0])
        label_y = int(corners[0][1]) - 14
        # Background for readability
        bbox = draw.textbbox((label_x, label_y), label, font=font)
        draw.rectangle(bbox, fill="black")
        draw.text((label_x, label_y), label, fill=color, font=font)

        num_drawn += 1

    img.save(output_path)
    return num_drawn


def main():
    try:
        from PIL import Image
    except ImportError:
        print("ERROR: pillow not installed. Run: pip install pillow")
        sys.exit(1)

    manifest_path = "debug/debug_manifest.json"
    output_all_path = "debug/overlay_all.png"
    output_filtered_path = "debug/overlay_filtered.png"

    if not os.path.exists(manifest_path):
        print(f"ERROR: Manifest not found: {manifest_path}")
        print("Run: python3 tools/decode_one.py first")
        sys.exit(1)

    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    image_file = manifest["image_file"]
    detections_all = manifest.get("detectionsOriginal", [])
    detections_filtered = manifest.get("detectionsFiltered", [])

    os.makedirs("debug", exist_ok=True)

    # Render all detections (after NMS)
    num_all = render_detections(image_file, detections_all, output_all_path, "All (after NMS)")
    print(f"Wrote: {output_all_path}")
    print(f"  Boxes drawn: {num_all}")

    # Render filtered detections
    num_filtered = render_detections(image_file, detections_filtered, output_filtered_path, "Filtered")
    print(f"Wrote: {output_filtered_path}")
    print(f"  Boxes drawn: {num_filtered}")

if __name__ == "__main__":
    main()
