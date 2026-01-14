#!/usr/bin/env python3
"""Run TFLite inference on first validation image and dump raw outputs."""

import json
import os
import sys
import glob
import numpy as np

def to_serializable(obj):
    """Convert numpy types to JSON-serializable Python types."""
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.integer, np.int32, np.int64)):
        return int(obj)
    if isinstance(obj, (np.floating, np.float32, np.float64)):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, dict):
        return {k: to_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_serializable(v) for v in obj]
    return obj

def main():
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
    images_dir = "ml/datasets/open_shelves/valid/images"
    output_dir = "debug"
    output_path = os.path.join(output_dir, "detections_raw.json")

    if not os.path.exists(model_path):
        print(f"ERROR: Model not found: {model_path}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    # Find first image
    patterns = [
        os.path.join(images_dir, "*.jpg"),
        os.path.join(images_dir, "*.jpeg"),
        os.path.join(images_dir, "*.png"),
    ]
    image_files = []
    for pattern in patterns:
        image_files.extend(glob.glob(pattern))
    image_files.sort()

    if not image_files:
        print(f"ERROR: No images found in {images_dir} with extensions jpg/jpeg/png")
        sys.exit(1)

    image_path = image_files[0]
    print(f"Image: {image_path}")

    # Load and preprocess image
    img = Image.open(image_path).convert("RGB")
    img_resized = img.resize((640, 640), Image.BILINEAR)
    img_array = np.array(img_resized, dtype=np.float32) / 255.0
    input_tensor = np.expand_dims(img_array, axis=0)  # [1, 640, 640, 3]

    print(f"Input shape: {input_tensor.shape}")
    print(f"Input dtype: {input_tensor.dtype}")
    print(f"Input range: [{input_tensor.min():.4f}, {input_tensor.max():.4f}]")

    # Load model and run inference
    print(f"\nLoading model: {model_path}")
    interpreter = tf.lite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    interpreter.set_tensor(input_details[0]["index"], input_tensor)
    interpreter.invoke()

    # Collect outputs
    outputs_info = []
    for detail in output_details:
        tensor = interpreter.get_tensor(detail["index"])
        flat = tensor.flatten()
        info = {
            "name": detail["name"],
            "shape": to_serializable(tensor.shape),
            "dtype": str(tensor.dtype),
            "min": float(tensor.min()),
            "max": float(tensor.max()),
            "mean": float(tensor.mean()),
            "sample_50": to_serializable(flat[:50]),
        }
        outputs_info.append(info)
        print(f"\nOutput: {info['name']}")
        print(f"  shape: {info['shape']}")
        print(f"  dtype: {info['dtype']}")
        print(f"  min: {info['min']:.6f}")
        print(f"  max: {info['max']:.6f}")
        print(f"  mean: {info['mean']:.6f}")

    payload = {
        "image_file": image_path,
        "input_shape": to_serializable(input_tensor.shape),
        "outputs": outputs_info,
    }

    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote: {output_path}")
    print("\n=== JSON PAYLOAD ===")
    print(json.dumps(payload, indent=2))

if __name__ == "__main__":
    main()
