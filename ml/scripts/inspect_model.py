#!/usr/bin/env python3
"""
Inspect TFLite model to document exact tensor IO contract.
This MUST be run after export to understand actual output format.
"""

import json
import sys
import os
from pathlib import Path

def inspect_tflite(model_path: str, output_path: str):
    """Inspect TFLite model and write IO contract to JSON."""
    try:
        import tensorflow as tf
    except ImportError:
        print("ERROR: TensorFlow not installed. Run: pip install tensorflow")
        sys.exit(1)

    if not os.path.exists(model_path):
        print(f"ERROR: Model not found: {model_path}")
        sys.exit(1)

    print(f"Inspecting: {model_path}")
    print()

    # Load model
    interpreter = tf.lite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

    # Get input details
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    print("=== INPUT TENSORS ===")
    inputs = []
    for i, detail in enumerate(input_details):
        info = {
            "index": i,
            "name": detail["name"],
            "shape": detail["shape"].tolist(),
            "dtype": str(detail["dtype"]),
            "quantization": {
                "scale": detail["quantization"][0] if detail["quantization"][0] != 0 else None,
                "zero_point": detail["quantization"][1] if detail["quantization"][0] != 0 else None,
            }
        }
        inputs.append(info)
        print(f"  [{i}] {detail['name']}")
        print(f"      Shape: {detail['shape']}")
        print(f"      Dtype: {detail['dtype']}")
        if detail["quantization"][0] != 0:
            print(f"      Quantization: scale={detail['quantization'][0]}, zero_point={detail['quantization'][1]}")
        print()

    print("=== OUTPUT TENSORS ===")
    outputs = []
    for i, detail in enumerate(output_details):
        info = {
            "index": i,
            "name": detail["name"],
            "shape": detail["shape"].tolist(),
            "dtype": str(detail["dtype"]),
            "quantization": {
                "scale": detail["quantization"][0] if detail["quantization"][0] != 0 else None,
                "zero_point": detail["quantization"][1] if detail["quantization"][0] != 0 else None,
            }
        }
        outputs.append(info)
        print(f"  [{i}] {detail['name']}")
        print(f"      Shape: {detail['shape']}")
        print(f"      Dtype: {detail['dtype']}")
        if detail["quantization"][0] != 0:
            print(f"      Quantization: scale={detail['quantization'][0]}, zero_point={detail['quantization'][1]}")
        print()

    # Analyze output format
    print("=== OUTPUT FORMAT ANALYSIS ===")
    main_output = output_details[0]
    shape = main_output["shape"].tolist()

    format_notes = []
    if len(shape) == 3:
        batch, dim1, dim2 = shape
        if dim2 == 6:  # OBB without angle
            format_notes.append("Format: [batch, num_detections, 6] - likely [x, y, w, h, conf, class]")
        elif dim2 == 7:
            format_notes.append("Format: [batch, num_detections, 7] - likely [x, y, w, h, angle, conf, class]")
        elif dim2 == 8:
            format_notes.append("Format: [batch, num_detections, 8] - likely [cx, cy, w, h, angle, conf, class, ?]")
        elif dim1 > dim2:
            format_notes.append(f"Format: [batch, {dim1}, {dim2}] - likely transposed: [batch, features, num_anchors]")
            format_notes.append("NOTE: May need transpose before decoding")
            if dim1 == 6:
                format_notes.append("Features likely: [x, y, w, h, conf, class] per anchor")
            elif dim1 == 7:
                format_notes.append("Features likely: [x, y, w, h, angle, conf, class] per anchor")
            elif dim1 > 7:
                num_classes = dim1 - 5  # Assuming x,y,w,h,angle + class scores
                format_notes.append(f"Features likely: [x, y, w, h, angle, class_scores...] with {num_classes} classes")
        else:
            format_notes.append(f"Unknown format: analyze raw output manually")
    elif len(shape) == 2:
        format_notes.append(f"Format: [batch, features] - single detection or flattened")
    else:
        format_notes.append(f"Shape: {shape} - analyze manually")

    for note in format_notes:
        print(f"  {note}")

    # Build contract
    contract = {
        "model_path": model_path,
        "inspected_at": str(Path(model_path).stat().st_mtime),
        "inputs": inputs,
        "outputs": outputs,
        "format_analysis": format_notes,
        "decode_notes": [
            "IMPORTANT: Verify format_analysis by running inference on test image",
            "Check if coordinates are normalized [0,1] or absolute pixels",
            "Check if output needs NMS or is already post-processed",
            "Verify angle units (radians vs degrees)"
        ]
    }

    # Write contract
    with open(output_path, "w") as f:
        json.dump(contract, f, indent=2)

    print()
    print(f"IO contract written to: {output_path}")
    print()
    print("=== NEXT STEPS ===")
    print("1. Review the output shape and format_analysis")
    print("2. Update inferenceService.ts decodeModelOutput() to match actual format")
    print("3. Run test inference to verify decode is correct")
    print()

    return contract


def main():
    script_dir = Path(__file__).parent
    ml_dir = script_dir.parent
    project_root = ml_dir.parent

    model_path = project_root / "src" / "models" / "yolov8_obb.tflite"
    output_path = ml_dir / "model_io_contract.json"

    if len(sys.argv) > 1:
        model_path = Path(sys.argv[1])
    if len(sys.argv) > 2:
        output_path = Path(sys.argv[2])

    contract = inspect_tflite(str(model_path), str(output_path))

    # Gate 3 check
    if contract["outputs"]:
        print("✓ Gate 3 PASS: Model IO contract documented")
    else:
        print("✗ Gate 3 FAIL: No outputs found")
        sys.exit(1)


if __name__ == "__main__":
    main()
