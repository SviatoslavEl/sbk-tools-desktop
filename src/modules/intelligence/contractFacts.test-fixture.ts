import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';
import type { ContractFactPlan, ContractUnitFacts } from './contractFactTypes';
import type { ContractFactJob } from './contractFactRun';

export function factSources(texts: string[]): IntelligenceSource[] {
  return [{ id: 'SYNTHETIC_SOURCE', name: 'Учебный документ', sha256: 'c'.repeat(64), text: texts.join('\n'),
    coverage: { complete: true, requiresOcr: false }, fragments: texts.map((text, index) => ({ id: `synthetic-${index}`, locator: `Учебный фрагмент ${index + 1}`, text })) }];
}
export function nativeFactSources(fragments: IntelligenceFragment[]): IntelligenceSource[] {
  return [{ ...factSources([])[0], text: fragments.map(f => f.text).join('\n'), fragments }];
}
/** Synthetic protocol-only response. It deliberately claims no business facts;
 * it is not an AI reply, semantic oracle or acceptance of source completeness. */
export function syntheticFacts(plan: ContractFactPlan, blockId: string, reviewPlanKey?: string,
  customize?: (units: ContractUnitFacts[]) => void): string {
  const block = plan.blocks.find(b => b.id === blockId)!;
  const units: ContractUnitFacts[] = block.unitIds.map(unitId => ({ unitId, status: plan.units.find(u => u.id === unitId)!.text.trim() ? 'not-relevant' : 'empty',
    facts: [], uncertainties: [], questions: [] }));
  customize?.(units);
  return JSON.stringify({ version: 1, protocol: plan.protocol, planKey: plan.planKey, blockId,
    ...(reviewPlanKey ? { reviewPlanKey } : {}), units, ...(reviewPlanKey ? { issues: [] } : {}) });
}
export function syntheticFactJobReply(plan: ContractFactPlan, job: ContractFactJob,
  customize?: (units: ContractUnitFacts[]) => void): { text: string; model: string } {
  const schema = job.responseSchema as { properties: { reviewPlanKey?: { enum: string[] } } };
  return { text: syntheticFacts(plan, job.blockId, schema.properties.reviewPlanKey?.enum[0], customize), model: 'SYNTHETIC_NO_MODEL' };
}
