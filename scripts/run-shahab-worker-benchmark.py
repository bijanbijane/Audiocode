#!/usr/bin/env python3
"""Run a one-process, offline Sherpa-ONNX benchmark over an ordered JSON manifest."""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--worker', default=os.path.join(os.path.dirname(__file__), '..', 'companion', 'shahab_sherpa_worker.py'))
    parser.add_argument('--model', required=True)
    parser.add_argument('--tokens', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--max-chunk-sec', type=float, default=50.0)
    args = parser.parse_args()

    manifest: list[dict[str, Any]] = json.load(open(args.manifest, encoding='utf-8'))
    if not manifest:
        raise ValueError('EMPTY_BENCHMARK_MANIFEST')
    missing = [row.get('wavPath') for row in manifest if not os.path.isfile(str(row.get('wavPath', '')))]
    if missing:
        raise FileNotFoundError(f'MISSING_AUDIO_FILES count={len(missing)} first={missing[:5]}')

    worker = os.path.abspath(args.worker)
    model = os.path.abspath(args.model)
    tokens = os.path.abspath(args.tokens)
    output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    stderr_path = output + '.worker-stderr.log'
    env = dict(os.environ)
    env.update({
        'http_proxy': 'http://127.0.0.1:9',
        'https_proxy': 'http://127.0.0.1:9',
        'HTTP_PROXY': 'http://127.0.0.1:9',
        'HTTPS_PROXY': 'http://127.0.0.1:9',
        'HF_HUB_OFFLINE': '1',
        'TRANSFORMERS_OFFLINE': '1',
        'PYTHONNOUSERSITE': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
    })

    print(f'[SHAHAB FLEURS] samples={len(manifest)} threads={args.threads} max_chunk={args.max_chunk_sec}s', flush=True)
    started = time.monotonic()
    stderr_file = open(stderr_path, 'w', encoding='utf-8')
    process = subprocess.Popen(
        [sys.executable, worker, '--model', model, '--tokens', tokens,
         '--num-threads', str(max(1, min(8, args.threads))),
         '--provider', 'cpu', '--max-chunk-sec', str(args.max_chunk_sec)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_file,
        text=True, encoding='utf-8', bufsize=1, env=env,
    )
    assert process.stdin is not None and process.stdout is not None
    try:
        ready_line = process.stdout.readline()
        if not ready_line:
            raise RuntimeError('WORKER_EXITED_BEFORE_READY')
        ready = json.loads(ready_line)
        if ready.get('type') != 'ready' or ready.get('ok') is not True:
            raise RuntimeError(f'WORKER_NOT_READY: {ready}')
        print(f"[SHAHAB FLEURS] model_ready runtime={ready.get('runtimeVersion')} elapsed={time.monotonic()-started:.2f}s", flush=True)

        failures = 0
        with open(output, 'w', encoding='utf-8') as result_file:
            for index, row in enumerate(manifest):
                request_id = f'fleurs-fa-test-{index:03d}'
                request = {'type': 'transcribe', 'requestId': request_id, 'wavPath': row['wavPath']}
                process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
                process.stdin.flush()
                result_line = process.stdout.readline()
                if not result_line:
                    raise RuntimeError(f'WORKER_DIED_AT_SAMPLE_{index}: {row["filename"]}')
                result = json.loads(result_line)
                if result.get('type') != 'result' or result.get('requestId') != request_id:
                    raise RuntimeError(f'WORKER_RESPONSE_MISMATCH_AT_SAMPLE_{index}: {result}')
                if result.get('ok') is not True:
                    failures += 1
                result_file.write(json.dumps(result, ensure_ascii=False) + '\n')
                if (index + 1) % 25 == 0 or index + 1 == len(manifest):
                    elapsed = time.monotonic() - started
                    rate = (index + 1) / elapsed if elapsed > 0 else 0
                    eta = (len(manifest) - index - 1) / rate if rate > 0 else 0
                    print(f'[SHAHAB FLEURS] {index+1}/{len(manifest)} failures={failures} elapsed={elapsed/60:.1f}m eta={eta/60:.1f}m', flush=True)
            result_file.flush()
            os.fsync(result_file.fileno())

        process.stdin.write(json.dumps({'type': 'shutdown', 'requestId': 'shutdown'}) + '\n')
        process.stdin.flush()
        process.stdin.close()
        shutdown_line = process.stdout.readline()
        return_code = process.wait(timeout=30)
        elapsed = time.monotonic() - started
        print(json.dumps({
            'samples': len(manifest), 'failures': failures, 'elapsedSeconds': round(elapsed, 2),
            'resultsPath': output, 'stderrPath': stderr_path,
            'workerShutdown': json.loads(shutdown_line) if shutdown_line else None,
            'returnCode': return_code,
        }, ensure_ascii=False), flush=True)
        return 2 if failures or return_code else 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        stderr_file.close()


if __name__ == '__main__':
    raise SystemExit(main())
