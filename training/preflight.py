#!/usr/bin/env python3
"""
AVAPARDAZ PHASE-06 — Training Hardware & Dependency Preflight (training/preflight.py)

Detects actual OS, CPU architecture & ISA flags, system RAM, available disk space,
Python version, ML package versions (PyTorch, Transformers, Accelerate, PEFT, qwen-asr),
CUDA / NVIDIA GPU, Apple MPS, ROCm, Transformers compatibility conflicts
(4.51.3 vs 4.57.6 vs >=5.13.0), and realistic training feasibility for
Qwen/Qwen3-ASR-0.6B and Qwen/Qwen3-ASR-1.7B (including 8 GB unified-memory guardrails).

Never fabricates GPU hardware, VRAM, or installed packages.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


def _read_linux_meminfo_mb() -> Tuple[Optional[int], Optional[int]]:
    if not os.path.exists("/proc/meminfo"):
        return None, None
    total_kb: Optional[int] = None
    avail_kb: Optional[int] = None
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
    except OSError:
        return None, None
    total_mb = total_kb // 1024 if total_kb is not None else None
    avail_mb = avail_kb // 1024 if avail_kb is not None else None
    return total_mb, avail_mb


def _read_macos_mem_mb() -> Tuple[Optional[int], Optional[int]]:
    if platform.system() != "Darwin":
        return None, None
    sysctl = shutil.which("sysctl")
    if not sysctl:
        return None, None
    try:
        proc = subprocess.run(
            [sysctl, "-n", "hw.memsize"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip().isdigit():
            return int(proc.stdout.strip()) // (1024 * 1024), None
    except Exception:
        return None, None
    return None, None


def _detect_cpu_isa_flags() -> List[str]:
    flags: List[str] = []
    if os.path.exists("/proc/cpuinfo"):
        try:
            with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.lower().startswith("flags") or line.lower().startswith("features"):
                        _, rhs = line.split(":", 1)
                        tokens = set(rhs.strip().lower().split())
                        for cand in ("sse4_2", "avx", "avx2", "avx512f", "avx512_vnni", "fma", "neon", "asimd"):
                            if cand in tokens:
                                flags.append(cand)
                        break
        except OSError:
            pass
    elif platform.machine().lower() in ("arm64", "aarch64"):
        flags.append("neon")
    return sorted(set(flags))


def _installed_pkg_version(dist_name: str, import_name: Optional[str] = None) -> Optional[str]:
    try:
        return importlib.metadata.version(dist_name)
    except importlib.metadata.PackageNotFoundError:
        pass
    mod_name = import_name or dist_name.replace("-", "_")
    if importlib.util.find_spec(mod_name) is not None:
        try:
            mod = __import__(mod_name)
            return getattr(mod, "__version__", "installed-unknown-version")
        except Exception:
            return "installed-import-error"
    return None


def _parse_version_tuple(ver: Optional[str]) -> Optional[Tuple[int, int, int]]:
    if not ver:
        return None
    m = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", ver.strip())
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def evaluate_transformers_compatibility(
    transformers_version: Optional[str],
    qwen_asr_version: Optional[str],
) -> Dict[str, Any]:
    """
    Evaluates the verified Qwen3-ASR dependency matrix:
    - Legacy broken lockfile: transformers==4.51.3 + qwen-asr==0.2.1 (INCOMPATIBLE)
    - Official qwen-asr track: qwen-asr==0.0.6 + transformers==4.57.6
    - Native HF Transformers track: transformers>=5.13.0 (AutoModelForMultimodalLM / qwen3_asr)
    """
    tf_tuple = _parse_version_tuple(transformers_version)
    if transformers_version is None:
        return {
            "status": "NOT_INSTALLED",
            "compatible_with_official_qwen_asr": False,
            "compatible_with_native_hf_qwen3_asr": False,
            "notes": "transformers is not installed in the current Python environment.",
        }

    is_legacy_conflict = tf_tuple is not None and tf_tuple < (4, 57, 6)
    is_official_qwen_asr_band = tf_tuple is not None and (4, 57, 6) <= tf_tuple < (5, 0, 0)
    is_native_hf_band = tf_tuple is not None and tf_tuple >= (5, 13, 0)

    if is_legacy_conflict:
        return {
            "status": "INCOMPATIBLE_LEGACY_VERSION",
            "compatible_with_official_qwen_asr": False,
            "compatible_with_native_hf_qwen3_asr": False,
            "notes": (
                f"Detected transformers=={transformers_version} (< 4.57.6). "
                "Incompatible with official qwen-asr==0.0.6 (requires 4.57.6) and native HF qwen3_asr (>= 5.13.0)."
            ),
        }
    if is_official_qwen_asr_band:
        return {
            "status": "COMPATIBLE_OFFICIAL_QWEN_ASR_TRACK",
            "compatible_with_official_qwen_asr": True,
            "compatible_with_native_hf_qwen3_asr": False,
            "notes": (
                f"transformers=={transformers_version} matches official qwen-asr track "
                f"(detected qwen-asr={qwen_asr_version or 'not-installed'})."
            ),
        }
    if is_native_hf_band:
        return {
            "status": "COMPATIBLE_NATIVE_HF_TRACK",
            "compatible_with_official_qwen_asr": False,
            "compatible_with_native_hf_qwen3_asr": True,
            "notes": (
                f"transformers=={transformers_version} supports native HF Qwen3-ASR checkpoints "
                "(Qwen/Qwen3-ASR-0.6B-hf, Qwen/Qwen3-ASR-1.7B-hf). Do not mix with qwen-asr==0.0.6."
            ),
        }
    return {
        "status": "UNVERIFIED_INTERMEDIATE_VERSION",
        "compatible_with_official_qwen_asr": False,
        "compatible_with_native_hf_qwen3_asr": False,
        "notes": (
            f"transformers=={transformers_version} falls in unverified gap (5.0.0..5.12.x). "
            "Pin 4.57.6 for official qwen-asr or >=5.13.0 for native HF."
        ),
    }


def evaluate_training_feasibility(
    *,
    gpu_detected: bool,
    pytorch_cuda_available: bool,
    total_vram_mb: int,
    mps_available: bool,
    system_ram_mb: Optional[int],
) -> Dict[str, Any]:
    """
    Conservative feasibility matrix for Qwen/Qwen3-ASR-0.6B and Qwen/Qwen3-ASR-1.7B.
    Explicitly guards against OOM on 8 GB unified-memory laptops (e.g. MacBook Air M2 8 GB).
    """
    vram_gb = total_vram_mb / 1024.0
    ram_gb = (system_ram_mb / 1024.0) if system_ram_mb is not None else 0.0

    if gpu_detected and pytorch_cuda_available:
        return {
            "qwen3_asr_0_6b_full_sft": vram_gb >= 16.0,
            "qwen3_asr_0_6b_lora": vram_gb >= 10.0,
            "qwen3_asr_1_7b_full_sft": vram_gb >= 40.0,
            "qwen3_asr_1_7b_lora": vram_gb >= 20.0,
            "mac_8gb_unified_oom_guard_triggered": False,
            "rationale": f"NVIDIA CUDA GPU detected ({vram_gb:.1f} GiB VRAM).",
        }

    if mps_available:
        is_8gb_class = ram_gb > 0 and ram_gb <= 10.0
        return {
            "qwen3_asr_0_6b_full_sft": False if is_8gb_class else ram_gb >= 24.0,
            "qwen3_asr_0_6b_lora": False if is_8gb_class else ram_gb >= 16.0,
            "qwen3_asr_1_7b_full_sft": False,
            "qwen3_asr_1_7b_lora": False if is_8gb_class else ram_gb >= 32.0,
            "mac_8gb_unified_oom_guard_triggered": is_8gb_class,
            "rationale": (
                "Apple MPS detected with <=10 GiB unified memory: full SFT and 1.7B/0.6B training "
                "blocked to prevent unified-memory OOM/swap thrashing; use inference-only or external CUDA GPU."
                if is_8gb_class
                else f"Apple MPS detected ({ram_gb:.1f} GiB unified memory); CUDA remains required for official BF16 SFT."
            ),
        }

    return {
        "qwen3_asr_0_6b_full_sft": False,
        "qwen3_asr_0_6b_lora": False,
        "qwen3_asr_1_7b_full_sft": False,
        "qwen3_asr_1_7b_lora": False,
        "mac_8gb_unified_oom_guard_triggered": False,
        "rationale": "CPU-only environment without CUDA/PyTorch accelerator; neural fine-tuning blocked.",
    }


def run_preflight_check() -> Dict[str, Any]:
    sys_ram_mb, avail_ram_mb = _read_linux_meminfo_mb()
    if sys_ram_mb is None:
        sys_ram_mb, avail_ram_mb = _read_macos_mem_mb()

    disk_usage = shutil.disk_usage(os.getcwd())
    cpu_isa_flags = _detect_cpu_isa_flags()

    pkg_versions = {
        "torch": _installed_pkg_version("torch"),
        "torchaudio": _installed_pkg_version("torchaudio"),
        "transformers": _installed_pkg_version("transformers"),
        "accelerate": _installed_pkg_version("accelerate"),
        "peft": _installed_pkg_version("peft"),
        "datasets": _installed_pkg_version("datasets"),
        "qwen_asr": _installed_pkg_version("qwen-asr", "qwen_asr"),
        "onnxruntime": _installed_pkg_version("onnxruntime"),
        "flash_attn": _installed_pkg_version("flash-attn", "flash_attn"),
    }

    report: Dict[str, Any] = {
        "preflight_version": "2.0.0-phase06",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "hostname": platform.node(),
        "os_system": platform.system(),
        "os_kernel": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "cpu_architecture": platform.machine(),
        "cpu_count": os.cpu_count() or 1,
        "cpu_isa_flags": cpu_isa_flags,
        "system_ram_total_mb": sys_ram_mb,
        "system_ram_available_mb": avail_ram_mb,
        "disk_free_gb": round(disk_usage.free / (1024 ** 3), 2),
        "python_version": platform.python_version(),
        "pip_available": bool(shutil.which("pip") or shutil.which("pip3")),
        "packages": pkg_versions,
        "gpu_detected": False,
        "gpu_model": None,
        "total_vram_mb": 0,
        "available_vram_mb": 0,
        "cuda_runtime_version": None,
        "pytorch_installed": pkg_versions["torch"] is not None,
        "pytorch_version": pkg_versions["torch"],
        "pytorch_cuda_available": False,
        "mps_available": False,
        "rocm_available": False,
        "bf16_supported": False,
        "fp16_supported": False,
        "flash_attention_available": pkg_versions["flash_attn"] is not None,
        "supported_accelerator": "NONE_CPU_ONLY",
        "transformers_compatibility": evaluate_transformers_compatibility(
            pkg_versions["transformers"],
            pkg_versions["qwen_asr"],
        ),
        "assigned_hardware_profile": "G0_CPU_ONLY",
        "full_1_7b_sft_ready_locally": False,
        "local_cpu_adapter_training_ready": True,
        "preflight_status": "BLOCKED_EXTERNAL_TRAINING_COMPUTE",
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
                check=False,
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

    # 2. Check PyTorch, CUDA, MPS, ROCm
    try:
        import torch  # type: ignore

        report["pytorch_installed"] = True
        report["pytorch_version"] = getattr(torch, "__version__", "unknown")
        report["pytorch_cuda_available"] = bool(torch.cuda.is_available())
        report["rocm_available"] = bool(getattr(torch.version, "hip", None))
        mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
        report["mps_available"] = bool(mps_backend and mps_backend.is_available())

        if report["pytorch_cuda_available"]:
            report["cuda_runtime_version"] = getattr(torch.version, "cuda", None)
            report["bf16_supported"] = bool(torch.cuda.is_bf16_supported())
            report["fp16_supported"] = True
            report["supported_accelerator"] = "ROCM" if report["rocm_available"] else "CUDA"
        elif report["mps_available"]:
            report["supported_accelerator"] = "APPLE_MPS"
    except ImportError:
        report["blockers"].append(
            "PYTORCH_NOT_INSTALLED: torch package is not installed in this G0 container."
        )

    if not report["pip_available"]:
        report["blockers"].append("PIP_NOT_INSTALLED: pip/pip3 unavailable in container.")

    if pkg_versions["transformers"] is None:
        report["blockers"].append("TRANSFORMERS_NOT_INSTALLED: transformers not installed.")

    # 3. Assign hardware profile & feasibility
    feasibility = evaluate_training_feasibility(
        gpu_detected=report["gpu_detected"],
        pytorch_cuda_available=report["pytorch_cuda_available"],
        total_vram_mb=report["total_vram_mb"],
        mps_available=report["mps_available"],
        system_ram_mb=sys_ram_mb,
    )
    report["training_feasibility"] = feasibility

    vram_gb = report["total_vram_mb"] / 1024.0
    if not report["gpu_detected"] or not report["pytorch_cuda_available"]:
        report["assigned_hardware_profile"] = (
            "G4_DEVELOPMENT_ACCELERATOR" if report["mps_available"] else "G0_CPU_ONLY"
        )
        report["full_1_7b_sft_ready_locally"] = False
        report["preflight_status"] = "BLOCKED_EXTERNAL_TRAINING_COMPUTE"
    elif vram_gb >= 75:
        report["assigned_hardware_profile"] = "G3_MULTI_GPU"
        report["full_1_7b_sft_ready_locally"] = True
        report["preflight_status"] = "READY_FOR_FULL_FINETUNING"
    elif vram_gb >= 40:
        report["assigned_hardware_profile"] = "G2_SINGLE_GPU_HIGH_MEMORY"
        report["full_1_7b_sft_ready_locally"] = True
        report["preflight_status"] = "READY_FOR_FULL_FINETUNING"
    elif vram_gb >= 15:
        report["assigned_hardware_profile"] = "G1_SINGLE_GPU_LIMITED"
        report["full_1_7b_sft_ready_locally"] = False
        report["preflight_status"] = "READY_FOR_0_6B_OR_LORA_ONLY"
    else:
        report["assigned_hardware_profile"] = "G0_LOW_VRAM"
        report["full_1_7b_sft_ready_locally"] = False
        report["preflight_status"] = "BLOCKED_INSUFFICIENT_VRAM"

    return report


if __name__ == "__main__":
    result = run_preflight_check()
    out_path = os.path.join(os.path.dirname(__file__), "preflight_report.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(json.dumps(result, indent=2, ensure_ascii=False))
