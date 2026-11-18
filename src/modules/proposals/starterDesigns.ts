import catalog from '../../../scanner-worker/resources/proposals/designs/catalog.json';
import type { ProposalTemplateLayout } from './templateDefinition';

export type StarterDesignId = keyof typeof catalog;
export interface StarterDesign {
  accent: string;
  logo?: string;
  coverArt?: string;
  footerArt?: string;
  cover?: string;
  footer?: string;
  paper: string;
  pricing: string;
  pagination: string;
  titleAlign: string;
}

export function getStarterDesign(id?: string): StarterDesign | undefined {
  if (!id || !Object.prototype.hasOwnProperty.call(catalog, id)) return undefined;
  return catalog[id as StarterDesignId];
}

export function getProposalDesign(id?: string, options?: ProposalTemplateLayout): StarterDesign | undefined {
  if (!options) return getStarterDesign(id);
  const base = getStarterDesign(options.base);
  const illustratedPortrait = base?.cover === 'illustrated' && options.paper === 'portrait';
  return {
    accent: base?.accent ?? '#245C48', logo: options.brand ? base?.logo : undefined,
    cover: options.cover ? (illustratedPortrait ? 'simple' : base?.cover ?? 'simple') : undefined,
    coverArt: options.cover && !illustratedPortrait ? base?.coverArt : undefined,
    footer: options.footerArt ? base?.footer ?? 'rule' : undefined, footerArt: options.footerArt ? base?.footerArt : undefined,
    titleAlign: options.titleAlign, paper: options.paper, pricing: options.pricing, pagination: options.pagination,
  };
}

const images = import.meta.glob<string>('../../../scanner-worker/resources/proposals/designs/*.png', {
  eager: true, query: '?url', import: 'default',
});

export function starterDesignImage(name?: string) {
  return name ? images[`../../../scanner-worker/resources/proposals/designs/${name}`] : undefined;
}
