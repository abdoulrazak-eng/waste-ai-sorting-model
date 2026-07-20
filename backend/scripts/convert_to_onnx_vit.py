import torch
import torch.nn as nn
from transformers import AutoModel

DINOV2_MODEL_NAME = "facebook/dinov2-base"
EMBED_DIM = 768


class DinoV2Classifier(nn.Module):
    """DINOv2 backbone + linear (or MLP) classification head."""

    def __init__(self, num_classes, freeze_backbone=False, hidden_dim=None):
        super().__init__()
        self.backbone = AutoModel.from_pretrained(DINOV2_MODEL_NAME)

        if freeze_backbone:
            for p in self.backbone.parameters():
                p.requires_grad = False

        if hidden_dim:
            self.head = nn.Sequential(
                nn.Linear(EMBED_DIM, hidden_dim),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Linear(hidden_dim, num_classes),
            )
        else:
            self.head = nn.Linear(EMBED_DIM, num_classes)

    def forward(self, pixel_values):
        outputs = self.backbone(pixel_values=pixel_values)
        # Use the CLS token embedding (pooler_output is CLS token after layernorm)
        cls_embedding = outputs.last_hidden_state[:, 0, :]
        logits = self.head(cls_embedding)
        return logits


def export_to_onnx(
    checkpoint_path: str,
    output_path: str,
    num_classes: int = 20,
    hidden_dim: int = 512,
    image_size: int = 224,
    opset_version: int = 17,
    dynamic_batch: bool = True,
):
    device = torch.device("cpu")  # export on CPU for portability

    model = DinoV2Classifier(
        num_classes=num_classes,
        freeze_backbone=True,
        hidden_dim=hidden_dim,
    ).to(device)

    state_dict = torch.load(checkpoint_path, map_location=device)["model_state_dict"]
    model.load_state_dict(state_dict)
    model.eval()

    # Dummy input matching preprocessing: (B, C, H, W), float32, normalized
    dummy_input = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)

    dynamic_axes = None
    if dynamic_batch:
        dynamic_axes = {
            "pixel_values": {0: "batch_size"},
            "logits": {0: "batch_size"},
        }

    with torch.inference_mode():
        torch.onnx.export(
            model,
            dummy_input,
            output_path,
            export_params=True,
            opset_version=opset_version,
            do_constant_folding=True,
            input_names=["pixel_values"],
            output_names=["logits"],
            dynamic_axes=dynamic_axes,
        )

    print(f"Exported ONNX model to: {output_path}")


def verify_onnx(output_path: str, checkpoint_path: str, num_classes: int, hidden_dim: int, image_size: int = 224):
    """Sanity check: compare PyTorch vs ONNXRuntime outputs on random input."""
    import onnxruntime as ort
    import numpy as np

    device = torch.device("cpu")
    model = DinoV2Classifier(num_classes=num_classes, freeze_backbone=True, hidden_dim=hidden_dim).to(device)
    state_dict = torch.load(checkpoint_path, map_location=device)["model_state_dict"]
    model.load_state_dict(state_dict)
    model.eval()

    x = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)

    with torch.inference_mode():
        torch_out = model(x).numpy()

    sess = ort.InferenceSession(output_path, providers=["CPUExecutionProvider"])
    onnx_out = sess.run(["logits"], {"pixel_values": x.numpy()})[0]

    max_diff = np.abs(torch_out - onnx_out).max()
    print(f"Max abs diff (torch vs onnx): {max_diff:.6e}")
    assert max_diff < 1e-3, "ONNX output diverges too much from PyTorch output!"
    print("ONNX export verified successfully.")


if __name__ == "__main__":
    CHECKPOINT = "/home/hassaan/projects/visionAI-cloud/backend/classifiers/transformer.pt"
    OUTPUT = "/home/hassaan/projects/visionAI-cloud/backend/classifiers/transformer.onnx"

    export_to_onnx(
        checkpoint_path=CHECKPOINT,
        output_path=OUTPUT,
        num_classes=20,
        hidden_dim=512,
        image_size=224,
        opset_version=17,
        dynamic_batch=True,
    )

    verify_onnx(OUTPUT, CHECKPOINT, num_classes=20, hidden_dim=512, image_size=224)