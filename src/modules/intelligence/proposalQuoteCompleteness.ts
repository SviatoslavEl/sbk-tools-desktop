import type { IntelligenceItem } from "./workbenchTypes";

// A conservative review trigger, NOT a semantic entailment/completeness test.
// A valid long quote can contain conditions absent from a literal short field.
// Keep those two observations separate; never repair or approve the model text.
const qualification = /(?:если|при\s+(?:этом|условии|наличии)|в\s+случае|по\s+согласовани|на\s+основе|за\s+исключением|только\s+при|вправе|не\s+(?:менее|более|ранее|позднее)|\b(?:if|unless|provided\s+that|subject\s+to)\b)/iu;
const literal = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Applies only after ordinary ownership/value checks. Fresh whole-section
 * provers may establish their own complete value separately. A false result
 * never establishes correctness; invalid quotes still fail the regular audit. */
export function proposalQuoteNeedsConditionReview(item: IntelligenceItem, field: string): boolean {
  if (item.destination !== "proposals" || !["paymentTerms", "deliveryTerms"].includes(field)
    || !item.selectedFields.includes(field) || typeof item.fields[field] !== "string") return false;
  const value = literal(item.fields[field]);
  if (!value || (item.evidence?.length || 0) > 500) return false;
  return Boolean(item.evidence?.some(claim => claim.field === field && claim.quote.length <= 4000
    && qualification.test(claim.quote) && !value.includes(literal(claim.quote))));
}
