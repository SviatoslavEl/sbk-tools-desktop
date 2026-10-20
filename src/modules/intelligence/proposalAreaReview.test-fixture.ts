/** SYNTHETIC test fixtures only. Never a provider fallback or verdict repair. */
import { PROPOSAL_AREA_REVIEW_CONTRACT, type ProposalAreaAnswer, type ProposalAreaReviewVerdict } from './proposalAreaPlan';

export const syntheticReviewContract = { reviewContract: PROPOSAL_AREA_REVIEW_CONTRACT } as const;
export function syntheticReview(status: ProposalAreaAnswer['status'], verdict: ProposalAreaReviewVerdict['verdict'] = 'supported',
  reason = 'SYNTHETIC fallible review; not semantic model accuracy.'): ProposalAreaReviewVerdict {
  const basis = status === 'unclear' ? 'uncertainty-assessment'
    : verdict === 'unclear' ? 'ambiguous-primary'
      : status === 'not-stated' ? verdict === 'supported' ? 'primary-no-answer' : 'primary-answer-found'
        : verdict === 'supported' ? 'answer-supported' : 'answer-unsupported';
  return { verdict, reason, basis, counterexample: null };
}
