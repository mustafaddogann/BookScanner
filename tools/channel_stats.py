import numpy as np
import tensorflow as tf
from PIL import Image

MODEL_PATH = "src/models/yolov8_obb.tflite"
IMAGE_PATH = "ml/datasets/open_shelves/valid/images/10_jpg.rf.4e5e76514881ee5eee62839951b1f411.jpg"

img = Image.open(IMAGE_PATH).convert("RGB").resize((640, 640))
x = np.asarray(img).astype(np.float32) / 255.0
x = np.expand_dims(x, 0)

itp = tf.lite.Interpreter(model_path=MODEL_PATH)
itp.allocate_tensors()
in0 = itp.get_input_details()[0]
itp.set_tensor(in0["index"], x)
itp.invoke()

od = itp.get_output_details()[0]
y = itp.get_tensor(od["index"])          # [1,6,8400]
y = y[0]                                 # [6,8400]

print("Output shape:", y.shape)
for i in range(y.shape[0]):
    v = y[i]
    q = np.quantile(v, [0.0, 0.01, 0.5, 0.99, 1.0])
    print(f"ch{i}: min={q[0]:.3f} p01={q[1]:.3f} med={q[2]:.3f} p99={q[3]:.3f} max={q[4]:.3f} mean={v.mean():.3f} std={v.std():.3f}")
