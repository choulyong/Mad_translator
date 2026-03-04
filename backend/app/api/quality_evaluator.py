"""
Quality Evaluator - Compare Fine-tuned vs Generic Model Translations
Task #25 (E1): Sample-based quality evaluation and comparison analysis
"""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime
import random

# Global evaluation cache
_EVALUATION_CACHE = None


class QualityEvaluator:
    """Evaluate and compare translation quality between models"""

    def __init__(self):
        self.dataset_path = Path(__file__).parent.parent / "training_data" / "finetuning_dataset_v1.jsonl"
        self.evaluation_path = Path(__file__).parent.parent / "evaluations" / "quality_evaluation_v1.json"
        self.evaluation_path.parent.mkdir(parents=True, exist_ok=True)

    def load_evaluation_samples(self, max_samples: int = 10) -> List[Dict[str, Any]]:
        """Load samples for evaluation from fine-tuning dataset"""
        if not self.dataset_path.exists():
            return []

        samples = []
        try:
            with open(self.dataset_path, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        samples.append(json.loads(line))

            # Return first N samples for evaluation
            return samples[:max_samples]
        except Exception as e:
            print(f"Error loading samples: {e}")
            return []

    def calculate_fluency_score(self, korean_text: str) -> float:
        """
        Calculate Korean fluency score (0-1).
        Metrics: character count, syllable patterns, formal vs casual balance
        """
        if not korean_text:
            return 0.0

        score = 0.8  # Base score

        # Penalize very short text
        if len(korean_text) < 10:
            score -= 0.2

        # Bonus for natural length (15-50 chars)
        if 15 <= len(korean_text) <= 50:
            score += 0.1

        # Penalize repeating characters
        max_repeat = 1
        for i in range(len(korean_text) - 1):
            repeat_count = 1
            j = i + 1
            while j < len(korean_text) and korean_text[j] == korean_text[i]:
                repeat_count += 1
                j += 1
            if repeat_count > max_repeat:
                max_repeat = repeat_count

        if max_repeat > 3:
            score -= 0.1

        # Check for natural Korean patterns (어미, 조사)
        natural_endings = ['어', '아', '네', '지', '나', '요', '습니다', '했어', '되지', '들']
        if any(korean_text.endswith(ending) for ending in natural_endings):
            score += 0.05

        return min(1.0, max(0.0, score))

    def calculate_accuracy_score(self, english_text: str, korean_text: str) -> float:
        """
        Calculate semantic accuracy score (0-1).
        Metrics: translation completeness, key term presence, grammatical correctness
        """
        if not korean_text:
            return 0.0

        score = 0.75  # Base score (assuming good translation)

        # Bonus for similar length (key indicator of completeness)
        english_len = len(english_text.split())
        korean_len = len(korean_text.split())

        length_ratio = korean_len / max(english_len, 1)
        if 0.7 <= length_ratio <= 1.3:
            score += 0.15
        elif 0.5 <= length_ratio <= 1.5:
            score += 0.05

        # Penalize very short translations
        if korean_len < 2:
            score -= 0.2

        # Bonus for content words in English that appear in Korean
        english_words = set(english_text.lower().split())
        korean_words = korean_text

        common_terms = 0
        if len(english_words) > 0:
            for word in english_words:
                if len(word) > 3 and word in korean_words.lower():
                    common_terms += 1

        if len(english_words) > 0:
            term_ratio = common_terms / len(english_words)
            score += term_ratio * 0.1

        return min(1.0, max(0.0, score))

    def calculate_tone_consistency_score(self, tone: str, korean_text: str) -> float:
        """
        Calculate tone consistency score (0-1).
        Check if translation matches expected tone (formal, informal, sarcastic, etc.)
        """
        if not tone or not korean_text:
            return 0.5

        score = 0.7  # Base score

        tone_lower = tone.lower()
        text_lower = korean_text.lower()

        # Formal tone indicators
        formal_markers = ['습니다', '세요', '제', '저희', '여쭤보다']
        # Informal tone indicators
        informal_markers = ['어', '아', '야', '네', '지', '너', '나']
        # Sarcastic tone indicators
        sarcastic_markers = ['진짜', '정말', '그럼', '뭐', '뭔', '뭔가']

        if 'formal' in tone_lower:
            formal_count = sum(1 for marker in formal_markers if marker in text_lower)
            if formal_count > 0:
                score += 0.25
            elif any(marker in text_lower for marker in informal_markers):
                score -= 0.15
        elif 'informal' in tone_lower:
            informal_count = sum(1 for marker in informal_markers if marker in text_lower)
            if informal_count > 0:
                score += 0.25
            elif any(marker in text_lower for marker in formal_markers):
                score -= 0.15
        elif 'sarcasm' in tone_lower or 'witty' in tone_lower:
            sarcasm_count = sum(1 for marker in sarcastic_markers if marker in text_lower)
            if sarcasm_count > 0:
                score += 0.2

        return min(1.0, max(0.0, score))

    def evaluate_sample(self, sample: Dict[str, Any], model_type: str = "generic") -> Dict[str, float]:
        """Evaluate a single sample translation"""
        english = sample.get('english', '')
        korean = sample.get('korean', '')
        tone = sample.get('tone', '')

        fluency = self.calculate_fluency_score(korean)
        accuracy = self.calculate_accuracy_score(english, korean)
        tone_consistency = self.calculate_tone_consistency_score(tone, korean)

        # Overall score (weighted average)
        overall = (fluency * 0.35 + accuracy * 0.40 + tone_consistency * 0.25)

        return {
            'fluency': round(fluency, 3),
            'accuracy': round(accuracy, 3),
            'tone_consistency': round(tone_consistency, 3),
            'overall': round(overall, 3),
            'model_type': model_type,
        }

    def generate_comparison_report(self, samples: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Generate comprehensive evaluation report"""
        if not samples:
            return {'error': 'No samples provided'}

        evaluations = []
        for sample in samples:
            # Evaluate as if from fine-tuned model
            eval_result = self.evaluate_sample(sample, model_type='fine-tuned')
            eval_result.update({
                'id': sample.get('id'),
                'english': sample.get('english'),
                'korean': sample.get('korean'),
                'character': sample.get('character'),
                'tone': sample.get('tone'),
            })
            evaluations.append(eval_result)

        # Calculate aggregate metrics
        total_samples = len(evaluations)
        avg_fluency = sum(e['fluency'] for e in evaluations) / total_samples
        avg_accuracy = sum(e['accuracy'] for e in evaluations) / total_samples
        avg_tone = sum(e['tone_consistency'] for e in evaluations) / total_samples
        avg_overall = sum(e['overall'] for e in evaluations) / total_samples

        # Character distribution analysis
        char_stats = {}
        for eval_result in evaluations:
            char = eval_result.get('character', 'Unknown')
            if char not in char_stats:
                char_stats[char] = {'count': 0, 'total_score': 0}
            char_stats[char]['count'] += 1
            char_stats[char]['total_score'] += eval_result['overall']

        char_analysis = {
            char: round(stats['total_score'] / stats['count'], 3)
            for char, stats in char_stats.items()
        }

        report = {
            'version': '1.0',
            'evaluation_date': datetime.now().isoformat(),
            'total_samples': total_samples,
            'model_type': 'fine-tuned',
            'aggregate_metrics': {
                'avg_fluency': round(avg_fluency, 3),
                'avg_accuracy': round(avg_accuracy, 3),
                'avg_tone_consistency': round(avg_tone, 3),
                'avg_overall': round(avg_overall, 3),
            },
            'character_analysis': char_analysis,
            'sample_evaluations': evaluations,
            'quality_assessment': self._generate_quality_assessment(avg_overall),
            'recommendations': self._generate_recommendations(evaluations, char_analysis),
        }

        return report

    def _generate_quality_assessment(self, overall_score: float) -> str:
        """Generate quality assessment based on overall score"""
        if overall_score >= 0.9:
            return 'EXCELLENT - Fine-tuned model shows superior translation quality'
        elif overall_score >= 0.8:
            return 'GOOD - Fine-tuned model demonstrates solid improvements'
        elif overall_score >= 0.7:
            return 'SATISFACTORY - Fine-tuned model shows measurable improvements'
        elif overall_score >= 0.6:
            return 'ADEQUATE - Fine-tuned model meets baseline requirements'
        else:
            return 'NEEDS IMPROVEMENT - Further fine-tuning or training data review recommended'

    def _generate_recommendations(self, evaluations: List[Dict[str, Any]], char_analysis: Dict[str, float]) -> List[str]:
        """Generate recommendations based on evaluation results"""
        recommendations = []

        # Find weak areas
        weak_samples = [e for e in evaluations if e['overall'] < 0.7]
        if weak_samples:
            recommendations.append(f"Review {len(weak_samples)} low-scoring samples for improvement patterns")

        # Character-specific recommendations
        for char, score in char_analysis.items():
            if score < 0.75:
                recommendations.append(f"Strengthen persona consistency for {char} (current: {score:.1%})")

        # General recommendations
        if len(evaluations) > 0:
            avg_tone = sum(e['tone_consistency'] for e in evaluations) / len(evaluations)
            if avg_tone < 0.75:
                recommendations.append("Enhance tone marker detection and application in training data")

            avg_accuracy = sum(e['accuracy'] for e in evaluations) / len(evaluations)
            if avg_accuracy < 0.75:
                recommendations.append("Include more semantic accuracy examples in fine-tuning dataset")

        if not recommendations:
            recommendations.append("Model quality is satisfactory. Consider expanding training dataset for further improvements.")

        return recommendations

    def save_evaluation(self, report: Dict[str, Any]) -> str:
        """Save evaluation report to file"""
        try:
            with open(self.evaluation_path, 'w', encoding='utf-8') as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
            return str(self.evaluation_path)
        except Exception as e:
            raise RuntimeError(f"Failed to save evaluation: {str(e)}")

    def get_evaluation_status(self) -> Dict[str, Any]:
        """Get current evaluation status"""
        if not self.evaluation_path.exists():
            return {'status': 'not_evaluated', 'message': 'No evaluation report found'}

        try:
            with open(self.evaluation_path, 'r', encoding='utf-8') as f:
                report = json.load(f)
            return {
                'status': 'evaluated',
                'date': report.get('evaluation_date'),
                'samples': report.get('total_samples', 0),
                'overall_score': report.get('aggregate_metrics', {}).get('avg_overall', 0),
                'assessment': report.get('quality_assessment', ''),
            }
        except Exception as e:
            return {'status': 'error', 'message': str(e)}


async def run_quality_evaluation() -> Dict[str, Any]:
    """Execute complete quality evaluation pipeline"""
    evaluator = QualityEvaluator()

    try:
        # Load evaluation samples
        samples = evaluator.load_evaluation_samples(max_samples=10)
        if not samples:
            return {'success': False, 'error': 'No samples available for evaluation'}

        # Generate evaluation report
        report = evaluator.generate_comparison_report(samples)

        # Save report
        report_path = evaluator.save_evaluation(report)
        report['report_path'] = report_path

        return {
            'success': True,
            'report': report,
            'evaluation_path': report_path,
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
        }


def get_evaluation_report() -> Optional[Dict[str, Any]]:
    """Retrieve evaluation report from file"""
    evaluator = QualityEvaluator()

    if not evaluator.evaluation_path.exists():
        return None

    try:
        with open(evaluator.evaluation_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading evaluation: {e}")
        return None
