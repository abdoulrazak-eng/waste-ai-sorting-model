
import argparse
from pathlib import Path
from pyexpat import model

import torch
import torchvision.models as models
import torch.nn as nn

def parse_args():
    parser = argparse.ArgumentParser(
        description="Export a PyTorch classification model to ONNX."
    )

    parser.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Path to the trained PyTorch checkpoint (.pth).",
    )

    parser.add_argument(
        "--num-classes",
        type=int,
        required=True,
        help="Number of classes in the classification task.",
    )
    parser.add_argument(
        "--feature-extractor",
        type=bool,
        help="Omits the classification layer"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default="waste_classification_model.onnx",
        help="Output ONNX model path.",
    )

    parser.add_argument(
        "--input-height",
        type=int,
        default=256,
        help="Input image height.",
    )

    parser.add_argument(
        "--input-width",
        type=int,
        default=256,
        help="Input image width.",
    )

    parser.add_argument(
        "--batch-size",
        type=int,
        default=1,
        help="Dummy input batch size used during export.",
    )

    parser.add_argument(
        "--channels",
        type=int,
        default=3,
        help="Number of input image channels.",
    )

    parser.add_argument(
        "--device",
        choices=["cpu", "cuda"],
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Device used during export.",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    device = torch.device(args.device)

    print(f"[INFO] Loading model...")
    model = models.resnet50()
    
    state_dict = torch.load(
    args.checkpoint,
    map_location=device,
    )
    num_features = model.fc.in_features
    model.fc = nn.Linear(num_features, args.num_classes)  
    model.load_state_dict(state_dict)
    if args.feature_extractor:
        model = torch.nn.Sequential(*(list(model.children())[:-1]))

  

    model.to(device)
    model.eval()

    example_input = torch.randn(
        args.batch_size,
        args.channels,
        args.input_height,
        args.input_width,
        device=device,
    )

    print("[INFO] Exporting to ONNX...")
    onnx_program = torch.onnx.export(
    model,
            (example_input,),
            dynamo=True,
            input_names=["x"],
            output_names=["output"],
            dynamic_shapes=({0: torch.export.Dim("batch_size")},),
        )

    onnx_program.save(args.output)

    print(f"[INFO] ONNX model saved to: {args.output}")

    print("[INFO] Running inference with ONNX Runtime...")

    
    import onnxruntime
    ort_session = onnxruntime.InferenceSession(args.output, providers=["CPUExecutionProvider"])
    onnxruntime_outputs = ort_session.run(None, {ort_session.get_inputs()[0].name: example_input.cpu().numpy()})[0]
    with torch.no_grad():
        torch_outputs = model(example_input)
    assert len(torch_outputs) == len(onnxruntime_outputs)
    for torch_output, onnxruntime_output in zip(torch_outputs, onnxruntime_outputs):
        torch.testing.assert_close(torch_output.detach().cpu(), torch.tensor(onnxruntime_output),  atol=1e-2,
    rtol=1e-2)

    print("PyTorch and ONNX Runtime output matched!")
    print(f"Output length: {len(onnxruntime_outputs)}")
    print(f"Sample output: {onnxruntime_outputs}")
    print(f"[INFO] Loading checkpoint: {args.checkpoint}")

if __name__ == "__main__":
    main()