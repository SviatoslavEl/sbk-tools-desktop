import type { IntelligenceSource } from "./workbenchTypes";

export interface ProposalIdentifierFact { value: string; sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string; supportingEvidence?: Omit<ProposalIdentifierFact, "value" | "supportingEvidence">[] }
const absent = /_{2,}|\.{2,}|^(?:нет|не|указать|заполнить|номер|предложение|договор|контракт|tbd|unknown|n\/?a)$/iu;
const token = String.raw`([\p{L}\d][\p{L}\d/_.-]{0,79})(?![\p{L}\d/_.-])`;
const reference = /(?:согласно|ссылка\s+на|см\.|в\s+ответ\s+на|в\s+соответствии\s+с|по\s+запросу)(?:[^\n;]{0,100})$/iu;
/** Contextual number syntax, never a SKU/model/contract-number substring. */
export function proposalIdentifiers(text: string, outgoing = false): string[] {
  const patterns = [new RegExp(String.raw`(?:^|[^\p{L}])(?:коммерческое\s+предложение|КП)\s*(?:№\s*|номер\s*[:—-]?\s*)[«"“]?\s*${token}`, "giu"), new RegExp(String.raw`(?:^|[^\p{L}])(?:номер|№)\s+(?:КП|коммерческого\s+предложения)\s*[:—-]?\s*[«"“]?\s*${token}`, "giu")];
  if (outgoing) patterns.push(new RegExp(String.raw`^\s*(?:исх\.?|исходящ(?:ий|ее))\s*№\s*${token}(?=\s+(?:от\s+\S)|\s*$)`, "giu"));
  return [...new Set(patterns.flatMap((pattern) => [...text.matchAll(pattern)].flatMap((match) => {
    const value = match[1].replace(/\.+$/u, "");
    const prefix = text.slice(0, match.index);
    return absent.test(value) || prefix.trim() || reference.test(prefix) ? [] : [value];
  })))];
}

/** Source-only bounded CP-header/outgoing-number inventory. No file names or
 * model fields establish the document's role; hidden/gaps/new sections reset. */
export function extractProposalIdentifierFacts(sources: readonly IntelligenceSource[]): { facts: ProposalIdentifierFact[]; limited: boolean } {
  const facts: ProposalIdentifierFact[] = []; let fragmentsSeen = 0, characters = 0;
  if (sources.length > 100 || new Set(sources.map((source) => source.id)).size !== sources.length) return { facts, limited: true };
  for (const source of sources) {
    const fragments = source.fragments === undefined ? [{ text: source.text, locator: "Текст источника", id: undefined, sheetId: undefined, sheetState: undefined }] : source.fragments;
    const fragmentIds = fragments.flatMap((fragment) => fragment.id ? [fragment.id] : []);
    if (new Set(fragmentIds).size !== fragmentIds.length) return { facts: [], limited: true };
    let heading: { proof: Omit<ProposalIdentifierFact, "value" | "supportingEvidence">; steps: number; characters: number; sheet: string } | undefined;
    for (const fragment of fragments) {
      if (++fragmentsSeen > 5000 || (characters += fragment.text.length) > 2 * 1024 * 1024 || fragment.text.length > 100_000) return { facts: [], limited: true };
      const paragraph = source.fragments === undefined || /^paragraph-\d+$/u.test(fragment.id || "") || !fragment.id && /^Абзац\s+\d+$/iu.test(fragment.locator);
      if (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden") { heading = undefined; continue; }
      if (heading && (!paragraph || heading.sheet !== (fragment.sheetId || ""))) heading = undefined;
      for (const line of fragment.text.split(/\r\n|\r|\n/u).filter((line) => line.trim())) {
        const proof = { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: line };
        const direct = proposalIdentifiers(line);
        if (line.length <= 2000) for (const value of direct) facts.push({ ...proof, value });
        if (facts.length > 100) return { facts: [], limited: true };
        if (/^\s*коммерческое\s+предложение\s*[:.]?\s*$/iu.test(line)) { heading = { proof, steps: 0, characters: line.length, sheet: fragment.sheetId || "" }; continue; }
        if (!heading) continue;
        if (++heading.steps > 8 || (heading.characters += line.length) > 1000) { heading = undefined; continue; }
        const outgoing = paragraph || heading.proof.fragmentId === fragment.id ? proposalIdentifiers(line, true) : [];
        if (outgoing.length) {
          if (line.length <= 2000) for (const value of outgoing) facts.push({ ...proof, value, supportingEvidence: [heading.proof] });
          if (facts.length > 100) return { facts: [], limited: true };
          heading = undefined;
        } else if (/^(?:договор|контракт|запрос|приложение|спецификация|заявка|акт|письмо|техническое\s+предложение|условия|порядок|срок)(?=$|[^\p{L}])/iu.test(line) || /\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2}/u.test(line)) heading = undefined;
      }
    }
  }
  return { facts, limited: false };
}
