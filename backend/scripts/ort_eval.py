import argparse
from pathlib import Path

import numpy as np
import onnxruntime
from torch.utils.data import DataLoader
from torchvision import datasets, transforms


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run ONNX Runtime inference/evaluation over an ImageFolder-style dataset split."
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=Path("models/waste_classification_model.onnx"),
        help="Path to the exported ONNX model.",
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        default=Path("/home/hassaan/Downloads/archive/dataset_split"),
        help="Root directory containing train/val/test subfolders (ImageFolder layout).",
    )
    parser.add_argument(
        "--split",
        choices=["train", "val", "test"],
        default="test",
        help="Which split to evaluate.",
    )
    parser.add_argument(
        "--input-size",
        type=int,
        default=256,
        help="Resize/crop size used during training.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Batch size for evaluation.",
    )
    parser.add_argument(
        "--num-workers",
        type=int,
        default=4,
        help="Number of DataLoader worker processes.",
    )
    return parser.parse_args()


def build_transform(input_size, split):
    # Matches your training pipeline exactly.
    normalize = transforms.Normalize(
        [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
    )
    if split == "train":
        return transforms.Compose([
            transforms.RandomResizedCrop(input_size),
            transforms.RandomHorizontalFlip(),
            transforms.ToTensor(),
            normalize,
        ])
    # val / test
    return transforms.Compose([
        transforms.Resize(input_size),
        transforms.CenterCrop(input_size),
        transforms.ToTensor(),
        normalize,
    ])


def build_dataloader(data_root, split, input_size, batch_size, num_workers):
    split_dir = data_root / split
    if not split_dir.exists():
        raise FileNotFoundError(f"Split directory not found: {split_dir}")

    transform = build_transform(input_size, split)
    dataset = datasets.ImageFolder(root=str(split_dir), transform=transform)
    print(dataset.class_to_idx)
    dataloader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=(split == "train"),
        num_workers=num_workers,
        pin_memory=False,
    )
    return dataset, dataloader


def softmax(logits):
    exp = np.exp(logits - np.max(logits, axis=1, keepdims=True))
    return exp / exp.sum(axis=1, keepdims=True)


def main():
    args = parse_args()

    print(f"[INFO] Loading ONNX model: {args.model}")
    ort_session = onnxruntime.InferenceSession(
        str(args.model), providers=["CPUExecutionProvider"]
    )
    input_name = ort_session.get_inputs()[0].name

    print(f"[INFO] Building '{args.split}' dataloader from: {args.data_root}")
    dataset, dataloader = build_dataloader(
        args.data_root, args.split, args.input_size, args.batch_size, args.num_workers
    )
    print(f"[INFO] Classes ({len(dataset.classes)}): {dataset.classes}")
    print(f"[INFO] Num samples: {len(dataset)}")

    total = 0
    correct = 0
    all_preds = []
    all_labels = []

    for inputs, labels in dataloader:
        onnx_inputs = {input_name: inputs.numpy(force=True)}
        logits = ort_session.run(None, onnx_inputs)[0]
        probs = softmax(logits)
        preds = probs.argmax(axis=1)

        labels_np = labels.numpy()
        correct += (preds == labels_np).sum()
        total += len(labels_np)

        all_preds.extend(preds.tolist())
        all_labels.extend(labels_np.tolist())

    acc = correct / total if total > 0 else 0.0
    print(f"[RESULT] {args.split} accuracy: {acc:.4f} ({correct}/{total})")

    return {
        "accuracy": acc,
        "predictions": all_preds,
        "labels": all_labels,
        "classes": dataset.classes,
    }


if __name__ == "__main__":
    main()