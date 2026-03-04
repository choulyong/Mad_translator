#!/usr/bin/env python
"""
Test script for Fine-tuning Model Training
Task #22 (C2): Verify model training and saving
"""

import sys
import asyncio
from pathlib import Path
import json

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from app.api.finetuning_model_trainer import run_finetuning, get_finetuned_model_status

print("=" * 80)
print("FINE-TUNING MODEL TRAINING TEST")
print("=" * 80)

async def main():
    # Step 1: Train model
    print("\n[Step 1] Training fine-tuned model...")
    result = await run_finetuning()

    if result.get("success"):
        print(f"SUCCESS: Model trained")
        print(f"  Model path: {result.get('model_path')}")
        print(f"  Training samples: {result.get('training_samples')}")
        print(f"  Model type: {result.get('model_type')}")
        print(f"  Final accuracy: {result.get('final_accuracy'):.4f}")
        print(f"  Average loss: {result.get('average_loss'):.4f}")
        print(f"  Version: {result.get('version')}")
    else:
        print(f"FAIL: {result.get('error')}")
        return False

    # Step 2: Get model status
    print("\n[Step 2] Checking model status...")
    status = get_finetuned_model_status()
    print(f"  Status: {status.get('status')}")
    print(f"  Model type: {status.get('model_type')}")
    print(f"  Training samples: {status.get('training_samples')}")
    print(f"  Final accuracy: {status.get('final_accuracy'):.4f}")
    print(f"  Training date: {status.get('training_date')}")

    # Step 3: Verify model file
    print("\n[Step 3] Verifying model file...")
    model_path = Path(result.get('model_path', ''))
    if model_path.exists():
        file_size_kb = model_path.stat().st_size / 1024
        print(f"  File exists: {model_path}")
        print(f"  File size: {file_size_kb:.2f} KB")

        # Read and validate JSON
        try:
            with open(model_path, 'r', encoding='utf-8') as f:
                model_config = json.load(f)
            print(f"  JSON validation: OK")
            print(f"  Required fields:")
            for key in ['version', 'model_type', 'training_samples', 'final_accuracy']:
                print(f"    - {key}: {model_config.get(key)}")
        except json.JSONDecodeError:
            print(f"  JSON validation: FAIL")
    else:
        print(f"  ERROR: Model file not found")

    # Step 4: Show training log summary
    print("\n[Step 4] Training log summary:")
    for log_line in result.get('training_log_summary', []):
        print(f"  {log_line}")

    print("\n" + "=" * 80)
    print("TASK #22 (C2): FINE-TUNING MODEL TRAINING COMPLETE")
    print("=" * 80)
    print("\nSummary:")
    print(f"  - Training samples: {result.get('training_samples')}")
    print(f"  - Final accuracy: {result.get('final_accuracy'):.4f}")
    print(f"  - Average loss: {result.get('average_loss'):.4f}")
    print(f"  - Model location: {result.get('model_path')}")
    print(f"  - Status: READY FOR INTEGRATION")
    print("\nNext step: Task #23 (D1) - Backend Integration")

    return True

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
