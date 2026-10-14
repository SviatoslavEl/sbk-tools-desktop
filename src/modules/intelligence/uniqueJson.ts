/** JSON.parse discards duplicate keys. Inspect the grammar before accepting a response. */
export function parseUniqueJson(raw: string): unknown {
  let position = 0;
  let values = 0;
  const syntax = () => { throw new Error("Ответ ИИ не является корректным JSON."); };
  const whitespace = () => { while (position < raw.length && /[\x20\t\r\n]/.test(raw[position])) position++; };
  const string = (): string => {
    const start = position;
    if (raw[position++] !== '"') return syntax();
    while (position < raw.length) {
      const character = raw[position++];
      if (character === "\\") { position++; continue; }
      if (character === '"') {
        try { return JSON.parse(raw.slice(start, position)) as string; } catch { return syntax(); }
      }
    }
    return syntax();
  };
  const value = (depth: number): void => {
    if (depth > 64 || ++values > 100_000) throw new Error("Ответ ИИ слишком сложный. Сократите число вложенных элементов.");
    whitespace();
    const character = raw[position];
    if (character === "{") {
      position++; whitespace();
      const keys = new Set<string>();
      if (raw[position] === "}") { position++; return; }
      while (position < raw.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error(`Ответ ИИ содержит повторённое поле «${key.slice(0, 80)}». Результат неоднозначен и не принят; исправьте ответ или повторите анализ.`);
        keys.add(key); whitespace();
        if (raw[position++] !== ":") return syntax();
        value(depth + 1); whitespace();
        if (raw[position] === "}") { position++; return; }
        if (raw[position++] !== ",") return syntax();
      }
      return syntax();
    }
    if (character === "[") {
      position++; whitespace();
      if (raw[position] === "]") { position++; return; }
      while (position < raw.length) {
        value(depth + 1); whitespace();
        if (raw[position] === "]") { position++; return; }
        if (raw[position++] !== ",") return syntax();
      }
      return syntax();
    }
    if (character === '"') { string(); return; }
    for (const literal of ["true", "false", "null"]) {
      if (raw.startsWith(literal, position)) { position += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(position));
    if (!number) return syntax();
    position += number[0].length;
  };
  value(0); whitespace();
  if (position !== raw.length) return syntax();
  try { return JSON.parse(raw) as unknown; } catch { return syntax(); }
}
