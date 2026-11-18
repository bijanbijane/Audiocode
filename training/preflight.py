#!/usr/bin/env python3
"""
PHASE 4 (Section 2.3) — GPU & TRAINING PREFLIGHT BENCHMARK (training/preflight.py)
Detects actual GPU/CPU availability, VRAM, CUDA runtime, PyTorch availability,
BF16/FP16 support, and emits a machine-readable JSON preflight report.
Never fabricates GPU hardware when running on a CPU-only container.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone


def run_preflight_check() -> dict:
    report = {
        "preflight_version": "1.0.0-phase4",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "hostname": platform.node(),
        "os_kernel": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "python_version": platform.python_version(),
        "cpu_count": os.cpu_count() or 1,
        "gpu_detected": False,
        "gpu_model": None,
        "total_vram_mb": 0,
        "available_vram_mb": 0,
        "cuda_runtime_version": None,
        "pytorch_installed": False,
        "pytorch_version": None,
        "pytorch_cuda_available": False,
        "bf16_supported": False,
        "fp16_supported": False,
        "flash_attention_available": False,
        "assigned_hardware_profile": "G0_CPU_ONLY",
        "full_1_7b_sft_ready_locally": False,
        "local_cpu_adapter_training_ready": True,
        "preflight_status": "BLOCKED_FOR_1_7B_GPU_SFT__READY_FOR_G0_CPU_PIPELINE",
        "blockers": [],
    }

    # 1. Check nvidia-smi
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            proc = subprocess.run(
                [
                    nvidia_smi,
                    "--query-gpu=name,memory.total,memory.free,driver_version",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                first_line = proc.stdout.strip().splitlines()[0]
                parts = [p.strip() for p in first_line.split(",")]
                if len(parts) >= 3:
                    report["gpu_detected"] = True
                    report["gpu_model"] = parts[0]
                    report["total_vram_mb"] = int(float(parts[1]))
                    report["available_vram_mb"] = int(float(parts[2]))
        except Exception as exc:
            report["blockers"].append(f"NVIDIA_SMI_ERROR: {str(exc)}")
    else:
        report["blockers"].append("NO_NVIDIA_GPU_DETECTED: nvidia-smi binary not found in container.")

    # 2. Check PyTorch & CUDA
    try:
        import torch  # type: ignore

        report["pytorch_installed"] = True
        report["pytorch_version"] = getattr(torch, "__version__", "unknown")
        report["pytorch_cuda_available"] = bool(torch.cuda.is_available())
        if report["pytorch_cuda_available"]:
            report["cuda_runtime_version"] = getattr(torch.version, "cuda", None)
            report["bf16_supported"] = bool(torch.cuda.is_bf16_supported())
            report["fp16_supported"] = True
    except ImportError:
        report["blockers"].append(
            "PYTORCH_NOT_INSTALLED: torch package is not installed in this G0 container."
        )

    # 3. Assign hardware profile (G0..G4)
    vram_gb = report["total_vram_mb"] / 1024.0
    if not report["gpu_detected"] or not report["pytorch_cuda_available"]:
        report["assigned_hardware_profile"] = "G0_CPU_ONLY"
        report["full_1_7b_sft_ready_locally"] = False
    elif vram_gb >= 75:
        report["assigned_hardware_profile"] = "G3_80GB_FULL_FINETUNE"
        report["full_1_7b_sft_ready_locally"] = True
        report["preflight_status"] = "READY_FOR_FULL_FINETUNING"
    elif vram_gb >= 44:
        report["assigned_hardware_profile"] = "G2_48GB_FULL_FINETUNE"
        report["full_1_7b_sft_ready_locally"] = True
        report["preflight_status"] = "READY_FOR_FULL_FINETUNING"
    elif vram_gb >= 15:
        report["assigned_hardware_profile"] = "G1_16_24GB_LIGHTWEIGHT"
        report["full_1_7b_sft_ready_locally"] = False
        report["preflight_status"] = "READY_FOR_0_6B_OR_LORA_ONLY"
    else:
        report["assigned_hardware_profile"] = "G0_LOW_VRAM"
        report["full_1_7b_sft_ready_locally"] = False

    return report


if __name__ == "__main__":
    result = run_preflight_check()
    out_path = os.path.join(os.path.dirname(__file__), "preflight_report.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(json.dumps(result, indent=2, ensure_ascii=False))
