import onnxruntime as ort
import torch
import numpy as np
import cv2
from torchvision import transforms
from PIL import Image

class RunInference:
    def __init__(self, onnx_path: str, image_size: int = 224, providers=None):
        self.image_size = image_size
        self.mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
        self.std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)

        if providers is None:
            available = ort.get_available_providers()
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if "CUDAExecutionProvider" in available else ["CPUExecutionProvider"]

        self.session = ort.InferenceSession(onnx_path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    def preprocess(self, image: Image.Image) -> np.ndarray:
        """
        Reproduces: transforms.Compose([ToTensor(), Normalize(mean, std)])
        but also enforces the fixed spatial size the ONNX graph was exported with
        (the original torch code never resized, which only worked by accident
        if every input image was already 224x224).
        """
        if image.mode != "RGB":
            image = image.convert("RGB")

        if image.size != (self.image_size, self.image_size):
            image = image.resize((self.image_size, self.image_size), Image.BICUBIC)

        arr = np.array(image).astype(np.float32) / 255.0        # HWC, [0,1]
        arr = arr.transpose(2, 0, 1)                              # CHW
        arr = (arr - self.mean) / self.std                        # normalize
        arr = np.expand_dims(arr, axis=0).astype(np.float32)      # NCHW
        return arr

    def predict(self, image_path: str):
        image = Image.open(image_path)
        pixel_values = self.preprocess(image)

        logits = self.session.run([self.output_name], {self.input_name: pixel_values})[0]
        pred_class = int(np.argmax(logits, axis=-1)[0])
        exp = np.exp(logits - np.max(logits, axis=1, keepdims=True))
        probs = exp / exp.sum(axis=1, keepdims=True)
        confidence = float(probs[0, pred_class])
        return pred_class, confidence

