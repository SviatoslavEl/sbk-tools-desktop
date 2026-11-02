/** SYNTHETIC test fixtures only. Never a provider fallback or verdict repair. */
import { PROPOSAL_AREA_REVIEW_CONTRACT, type ProposalAreaAnswer, type ProposalAreaReviewVerdict } from './proposalAreaPlan';

export const syntheticReviewContract = { reviewContract: PROPOSAL_AREA_REVIEW_CONTRACT, schemaCarrier: 'prompt' } as const;
export function syntheticReview(status: ProposalAreaAnswer['status'], verdict: ProposalAreaReviewVerdict['verdict'] = 'supported',
  reason = 'SYNTHETIC fallible review; not semantic model accuracy.'): ProposalAreaReviewVerdict {
  const basis = status === 'unclear' ? 'uncertainty-assessment'
    : verdict === 'unclear' ? 'ambiguous-primary'
      : status === 'not-stated' ? verdict === 'supported' ? 'primary-no-answer' : 'primary-answer-found'
        : verdict === 'supported' ? 'answer-supported' : 'answer-unsupported';
  const decision = status === 'unclear' ? verdict === 'supported' ? 'uncertainty-justified' : verdict === 'unsupported' ? 'uncertainty-unjustified' : 'source-ambiguous'
    : verdict === 'unclear' ? 'source-ambiguous' : status === 'not-stated' ? verdict === 'supported' ? 'local-absence-confirmed' : 'direct-area-fact-found'
      : verdict === 'supported' ? 'answer-complete' : 'answer-not-supported';
  return { decision, verdict, reason, basis, counterexample: null };
}
