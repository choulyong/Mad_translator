#!/usr/bin/env python
"""
Test script for Quality Evaluation
Task #25 (E1): Verify evaluation system
"""

import sys
import asyncio
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from app.api.quality_evaluator import QualityEvaluator, run_quality_evaluation, get_evaluation_report

print("=" * 80)
print("QUALITY EVALUATION TEST")
print("=" * 80)

async def main():
    # Step 1: Initialize evaluator
    print("\n[Step 1] Initializing evaluator...")
    evaluator = QualityEvaluator()
    print("  Evaluator initialized [OK]")

    # Step 2: Load samples
    print("\n[Step 2] Loading evaluation samples...")
    samples = evaluator.load_evaluation_samples(max_samples=10)
    print(f"  Loaded {len(samples)} samples [OK]")

    if not samples:
        print("  ERROR: No samples found!")
        return False

    # Step 3: Show sample data
    print("\n[Step 3] Sample data preview:")
    for i, sample in enumerate(samples[:2], 1):
        print(f"\n  Sample {i}:")
        print(f"    English: {sample.get('english')}")
        print(f"    Korean: {sample.get('korean')}")
        print(f"    Character: {sample.get('character')}")
        print(f"    Tone: {sample.get('tone')}")

    # Step 4: Evaluate single sample
    print("\n[Step 4] Evaluating first sample...")
    eval_result = evaluator.evaluate_sample(samples[0])
    print(f"  Fluency: {eval_result['fluency']:.3f}")
    print(f"  Accuracy: {eval_result['accuracy']:.3f}")
    print(f"  Tone Consistency: {eval_result['tone_consistency']:.3f}")
    print(f"  Overall: {eval_result['overall']:.3f} [OK]")

    # Step 5: Generate full report
    print("\n[Step 5] Generating full evaluation report...")
    report = evaluator.generate_comparison_report(samples)
    print(f"  Report generated [OK]")

    # Step 6: Show report summary
    print("\n[Step 6] Report summary:")
    metrics = report.get('aggregate_metrics', {})
    print(f"  Total Samples: {report.get('total_samples')}")
    print(f"  Avg Fluency: {metrics.get('avg_fluency', 0):.3f}")
    print(f"  Avg Accuracy: {metrics.get('avg_accuracy', 0):.3f}")
    print(f"  Avg Tone: {metrics.get('avg_tone_consistency', 0):.3f}")
    print(f"  Avg Overall: {metrics.get('avg_overall', 0):.3f}")
    print(f"\n  Quality Assessment:")
    print(f"    {report.get('quality_assessment')}")

    # Step 7: Save report
    print("\n[Step 7] Saving report...")
    report_path = evaluator.save_evaluation(report)
    print(f"  Saved to: {report_path} [OK]")

    # Step 8: Run full async pipeline
    print("\n[Step 8] Running full async evaluation pipeline...")
    result = await run_quality_evaluation()
    if result.get('success'):
        print(f"  Pipeline completed successfully [OK]")
        eval_report = result.get('report', {})
        print(f"  Samples evaluated: {eval_report.get('total_samples')}")
        print(f"  Overall score: {eval_report.get('aggregate_metrics', {}).get('avg_overall', 0):.3f}")
    else:
        print(f"  Pipeline failed: {result.get('error')}")
        return False

    # Step 9: Retrieve report
    print("\n[Step 9] Retrieving saved report...")
    retrieved_report = get_evaluation_report()
    if retrieved_report:
        print(f"  Report retrieved successfully [OK]")
        print(f"  Samples: {retrieved_report.get('total_samples')}")
    else:
        print(f"  Failed to retrieve report")
        return False

    print("\n" + "=" * 80)
    print("TASK #25 (E1): QUALITY EVALUATION COMPLETE [OK]")
    print("=" * 80)
    print("\nSummary:")
    print(f"  ✓ Samples evaluated: {report.get('total_samples')}")
    print(f"  ✓ Average score: {metrics.get('avg_overall', 0):.1%}")
    print(f"  ✓ Characters analyzed: {len(report.get('character_analysis', {}))}")
    print(f"  ✓ Recommendations: {len(report.get('recommendations', []))}")
    print(f"  ✓ Report saved: {report_path}")

    return True

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
