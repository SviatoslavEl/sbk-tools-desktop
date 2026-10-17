/** Contextual identifiers only: a law, annex or power-of-attorney number must
 * never become a contract number merely because a contract is mentioned nearby.
 * Parenthesised registry identifiers are retained in full; only their explicitly
 * printed primary token is also a valid short alias. */
export function contractIdentifiers(text: string): string[] {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-").replace(/\s+/gu, " ").trim();
  const identifiers = new Set<string>();
  const patterns = [
    /(?:^|[^\p{L}])(?:договор|контракт)(?!\p{L})([^;\t\n№.]{0,100})№\s*[«"“]?\s*([\p{L}\d][\p{L}\d/._-]{0,79})/giu,
    /(?:^|[^\p{L}])(?:номер|№)\s+(?:договора|контракта)\s*[:—-]?\s*[«"“]?\s*([\p{L}\d][\p{L}\d/._-]{0,79})/giu,
  ];
  const empty = /_{2,}|\.{2,}|^(?:договор(?:а)?|контракт(?:а)?|поставк[аи]|приложени[ея]|номер|не|нет|от|без|указать|вставить|заполнить|неизвестно|не(?:указан|присвоен)[аоы]?|проект|TBD)$/iu;
  for (const [index, pattern] of patterns.entries()) for (const match of text.matchAll(pattern)) {
    if (index === 0 && /(?:приложени|спецификаци|доверенност|федеральн|закон|постановлен|счет)/iu.test(match[1])) continue;
    const token = match[index === 0 ? 2 : 1];
    // Do not confirm a truncated prefix at the token/length boundary.
    const tail = text.slice(match.index! + match[0].length);
    if (/^[\p{L}\d/_.-]/u.test(tail) || empty.test(token)) continue;
    const primary = token.replace(/\.+$/u, "");
    const suffix = /^\s{0,8}\(([\p{L}\d/_. -]{1,80})\)/u.exec(tail);
    if (suffix) {
      if (/^(?:[\p{L}\d/_-]|\.(?=[\p{L}\d])|\s*\()/u.test(tail.slice(suffix[0].length))) continue;
      const content = suffix[1].trim();
      if (!content || empty.test(content) || /(?:договор|контракт|доверенност|закон|приложени|спецификаци|\bTBD\b)/iu.test(content)) continue;
      identifiers.add(normalize(`${primary} (${content})`));
      if (/^\d{3,12}(?:[-/]\d{3,12}){2,4}$/u.test(content)) identifiers.add(normalize(primary));
    } else if (!/^\s*\(/u.test(tail)) identifiers.add(normalize(primary));
  }
  return [...identifiers];
}
