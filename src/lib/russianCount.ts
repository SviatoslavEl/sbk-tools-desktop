/** Russian count forms: один источник, два источника, пять источников. */
export function russianCountWord(count: number, forms: readonly [string, string, string]): string {
  const value = Math.abs(count);
  if (!Number.isFinite(value)) return forms[2];
  if (!Number.isInteger(value)) return forms[1];
  const hundred = value % 100, ten = value % 10;
  if (hundred >= 11 && hundred <= 14) return forms[2];
  return ten === 1 ? forms[0] : ten >= 2 && ten <= 4 ? forms[1] : forms[2];
}

export function formatRussianCount(count: number, forms: readonly [string, string, string]): string {
  return `${count.toLocaleString("ru")} ${russianCountWord(count, forms)}`;
}
