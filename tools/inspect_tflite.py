#!/usr/bin/env python3
"""Inspect TFLite model and write IO contract to JSON."""

import json
import os
import sys
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

    model_path = "src/models/yolov8_obb.tflite"
    output_dir = "debug"
    output_path = os.path.join(output_dir, "model_io.json")

    if not os.path.exists(model_path):
        print(f"ERROR: Model not found: {model_path}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    print(f"Loading model: {model_path}")
    interpreter = tf.lite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    inputs = []
    print("\n=== INPUT TENSORS ===")
    for detail in input_details:
        info = {
            "index": to_serializable(detail["index"]),
            "name": detail["name"],
            "shape": to_serializable(detail["shape"]),
            "dtype": str(detail["dtype"]),
            "quantization": to_serializable(detail.get("quantization", ())),
            "quantization_parameters": to_serializable(detail.get("quantization_parameters", {})),
        }
        inputs.append(info)
        print(f"  index={info['index']} name={info['name']} shape={info['shape']} dtype={info['dtype']}")
        print(f"    quantization={info['quantization']}")
        print(f"    quantization_parameters={info['quantization_parameters']}")

    outputs = []
    print("\n=== OUTPUT TENSORS ===")
    for detail in output_details:
        info = {
            "index": to_serializable(detail["index"]),
            "name": detail["name"],
            "shape": to_serializable(detail["shape"]),
            "dtype": str(detail["dtype"]),
            "quantization": to_serializable(detail.get("quantization", ())),
            "quantization_parameters": to_serializable(detail.get("quantization_parameters", {})),
        }
        outputs.append(info)
        print(f"  index={info['index']} name={info['name']} shape={info['shape']} dtype={info['dtype']}")
        print(f"    quantization={info['quantization']}")
        print(f"    quantization_parameters={info['quantization_parameters']}")

    contract = {
        "model_path": model_path,
        "inputs": inputs,
        "outputs": outputs,
    }

    with open(output_path, "w") as f:
        json.dump(contract, f, indent=2)

    print(f"\nWrote: {output_path}")

if __name__ == "__main__":
    main()
