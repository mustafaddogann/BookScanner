#!/usr/bin/env python3
"""Merge new Roboflow YOLOv5-OBB export into existing YOLOv8-OBB dataset.

Converts:
  YOLOv5-OBB: x1 y1 x2 y2 x3 y3 x4 y4 class_name difficulty (absolute px)
  → YOLOv8-OBB: class_id x1 y1 x2 y2 x3 y3 x4 y4 (normalized 0-1)

Then copies images + converted labels into the existing dataset.
"""

import os
import shutil
import glob

NEW_EXPORT = os.path.expanduser(
    "~/projects/bookseller/BookScanner/ml/new_shelf_export"
)
EXISTING_DS = os.path.expanduser(
    "~/projects/bookseller/BookScanner/ml/datasets/open_shelves"
)

IMG_W = 640.0
IMG_H = 640.0
CLASS_ID = 0  # single class: book


def convert_label_file(src_path):
    """Convert a YOLOv5-OBB label file to YOLOv8-OBB format (normalized)."""
    lines_out = []
    with open(src_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            # YOLOv5-OBB: x1 y1 x2 y2 x3 y3 x4 y4 class_name difficulty
            # Need at least 8 coordinate values
            if len(parts) < 9:
                continue
            coords = [float(p) for p in parts[:8]]
            # Normalize to 0-1
            norm = []
            for i, c in enumerate(coords):
                if i % 2 == 0:  # x coordinate
                    norm.append(c / IMG_W)
                else:  # y coordinate
                    norm.append(c / IMG_H)
            coord_str = " ".join(f"{v:.6f}" for v in norm)
            lines_out.append(f"{CLASS_ID} {coord_str}")
    return "\n".join(lines_out) + "\n" if lines_out else ""


def merge_split(split_name):
    """Merge one split (train/valid/test)."""
    new_img_dir = os.path.join(NEW_EXPORT, split_name, "images")
    new_lbl_dir = os.path.join(NEW_EXPORT, split_name, "labelTxt")

    if not os.path.isdir(new_img_dir):
        print(f"  Skip {split_name}: no images dir")
        return 0

    existing_img_dir = os.path.join(EXISTING_DS, split_name, "images")
    existing_lbl_dir = os.path.join(EXISTING_DS, split_name, "labels")

    os.makedirs(existing_img_dir, exist_ok=True)
    os.makedirs(existing_lbl_dir, exist_ok=True)

    count = 0
    for img_file in sorted(os.listdir(new_img_dir)):
        if not img_file.lower().endswith((".jpg", ".jpeg", ".png")):
            continue

        # Copy image
        src_img = os.path.join(new_img_dir, img_file)
        dst_img = os.path.join(existing_img_dir, img_file)
        shutil.copy2(src_img, dst_img)

        # Convert and write label
        base = os.path.splitext(img_file)[0]
        src_lbl = os.path.join(new_lbl_dir, base + ".txt")
        dst_lbl = os.path.join(existing_lbl_dir, base + ".txt")

        if os.path.exists(src_lbl):
            converted = convert_label_file(src_lbl)
            with open(dst_lbl, "w") as f:
                f.write(converted)
        else:
            print(f"  WARNING: no label for {img_file}")

        count += 1

    return count


def main():
    print("Merging new shelf photos into existing dataset...")
    print(f"  Source: {NEW_EXPORT}")
    print(f"  Target: {EXISTING_DS}")
    print()

    # Count existing images before merge
    for split in ["train", "valid", "test"]:
        img_dir = os.path.join(EXISTING_DS, split, "images")
        if os.path.isdir(img_dir):
            n = len(os.listdir(img_dir))
            print(f"  Existing {split}: {n} images")

    print()

    total = 0
    for split in ["train", "valid", "test"]:
        n = merge_split(split)
        print(f"  Merged {n} images into {split}/")
        total += n

    print(f"\n  Total merged: {total} images")

    # Count after merge
    print()
    for split in ["train", "valid", "test"]:
        img_dir = os.path.join(EXISTING_DS, split, "images")
        lbl_dir = os.path.join(EXISTING_DS, split, "labels")
        n_img = len(os.listdir(img_dir)) if os.path.isdir(img_dir) else 0
        n_lbl = len(os.listdir(lbl_dir)) if os.path.isdir(lbl_dir) else 0
        print(f"  Final {split}: {n_img} images, {n_lbl} labels")

    # Verify a converted label
    print("\n  Sample converted label:")
    sample_dir = os.path.join(EXISTING_DS, "train", "labels")
    new_labels = [f for f in os.listdir(sample_dir) if "IMG_3" in f]
    if new_labels:
        sample = os.path.join(sample_dir, sorted(new_labels)[0])
        with open(sample) as f:
            for line in f.readlines()[:3]:
                print(f"    {line.rstrip()}")


if __name__ == "__main__":
    main()
