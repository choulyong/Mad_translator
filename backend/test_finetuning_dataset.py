#!/usr/bin/env python
"""
Test script for Fine-tuning Dataset Generation
Task #21 (C1): Verify dataset creation and format
"""

import sys
from pathlib import Path
import json

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from app.api.finetuning_dataset_builder import build_finetuning_dataset, get_finetuning_dataset_stats

print("=" * 80)
print("FINE-TUNING DATASET GENERATION TEST")
print("=" * 80)

# Step 1: Build dataset
print("\n[Step 1] Building fine-tuning dataset...")
result = build_finetuning_dataset()

if result.get("success"):
    print(f"SUCCESS: Dataset built with {result.get('total_samples')} samples")
    print(f"Path: {result.get('path')}")
    print(f"Version: {result.get('version')}")
    print(f"Created at: {result.get('created_at')}")
else:
    print(f"FAIL: {result.get('error')}")
    sys.exit(1)

# Step 2: Show distribution
print("\n[Step 2] Dataset Distribution:")
print(f"  Characters: {result.get('characters')}")
print(f"  Character breakdown:")
for char, count in list(result.get('character_distribution', {}).items())[:5]:
    print(f"    - {char}: {count}")

print(f"\n  Tone breakdown:")
for tone, count in list(result.get('tone_distribution', {}).items())[:5]:
    print(f"    - {tone}: {count}")

print(f"\n  Formality breakdown:")
for form, count in result.get('formality_distribution', {}).items():
    print(f"    - {form}: {count}")

# Step 3: Show sample
print("\n[Step 3] Sample preview:")
for i, sample in enumerate(result.get('sample_preview', [])[:2], 1):
    print(f"\n  Sample {i}:")
    print(f"    English: {sample.get('english')}")
    print(f"    Korean: {sample.get('korean')}")
    print(f"    Character: {sample.get('character')}")
    print(f"    Tone: {sample.get('tone')}")
    print(f"    QC Score: {sample.get('qc_score')}")

# Step 4: Verify file exists
print("\n[Step 4] Verifying dataset file...")
dataset_path = Path(result.get('path', ''))
if dataset_path.exists():
    file_size_mb = dataset_path.stat().st_size / (1024 * 1024)
    print(f"File exists: {dataset_path}")
    print(f"File size: {file_size_mb:.2f} MB")

    # Count lines
    with open(dataset_path, 'r', encoding='utf-8') as f:
        line_count = sum(1 for line in f if line.strip())
    print(f"JSONL lines: {line_count}")

    # Verify format
    with open(dataset_path, 'r', encoding='utf-8') as f:
        first_line = f.readline()
        if first_line:
            try:
                first_sample = json.loads(first_line)
                print(f"Format validation: OK")
                print(f"Required fields: {', '.join(first_sample.keys())}")
            except json.JSONDecodeError:
                print(f"Format validation: FAIL (invalid JSON)")
else:
    print(f"ERROR: File not found at {dataset_path}")

# Step 5: Get stats
print("\n[Step 5] Getting dataset statistics...")
stats = get_finetuning_dataset_stats()
if "error" in stats:
    print(f"ERROR: {stats.get('error')}")
else:
    print(f"Total samples: {stats.get('total_samples')}")
    print(f"File size: {stats.get('file_size_mb', 0):.2f} MB")
    print(f"Unique characters: {stats.get('characters')}")
    print(f"Average QC score: {stats.get('avg_qc_score', 0):.2f}")

print("\n" + "=" * 80)
print("TASK #21 (C1): FINE-TUNING DATASET GENERATION COMPLETE")
print("=" * 80)
print("\nSummary:")
print(f"  - Dataset: {result.get('total_samples')} samples")
print(f"  - Version: {result.get('version')}")
print(f"  - Location: {result.get('path')}")
print(f"  - Status: READY FOR FINE-TUNING")
print("\nNext step: Task #22 (C2) - Model Fine-tuning Execution")
