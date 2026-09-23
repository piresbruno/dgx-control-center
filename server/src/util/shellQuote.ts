/** POSIX single-quote escaping for embedding one value into a shell string. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
