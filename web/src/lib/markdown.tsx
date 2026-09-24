import type { ReactNode } from "react";

/**
 * Minimal dependency-free markdown renderer for streaming chat output.
 * Returns React elements (never HTML strings), so untrusted model output
 * cannot inject markup. Supports fenced code, headings, lists, paragraphs,
 * inline code, bold/italic and links — enough for model replies.
 */

type Inline = ReactNode;

/** Inline pass: `code`, **bold**, *italic* / _italic_, [text](url). */
function renderInline(text: string, keyPrefix: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  let key = 0;
  const patterns: Array<{ re: RegExp; render: (match: RegExpMatchArray) => ReactNode }> = [
    {
      re: /`([^`]+)`/,
      render: (m) => <code key={`${keyPrefix}-c${key}`}>{m[1]}</code>,
    },
    {
      re: /\*\*([^*]+)\*\*/,
      render: (m) => <strong key={`${keyPrefix}-b${key}`}>{m[1]}</strong>,
    },
    {
      // Lookbehind keeps the separator out of the match, so the split stays aligned.
      re: /(?<=^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/,
      render: (m) => <em key={`${keyPrefix}-i${key}`}>{m[1]}</em>,
    },
    {
      re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
      render: (m) => (
        <a key={`${keyPrefix}-a${key}`} href={m[2]} target="_blank" rel="noreferrer noopener">
          {m[1]}
        </a>
      ),
    },
  ];

  for (;;) {
    let best: { index: number; length: number; node: ReactNode } | null = null;
    for (const pattern of patterns) {
      const match = rest.match(pattern.re);
      if (!match || match.index === undefined) continue;
      if (!best || match.index < best.index) {
        best = { index: match.index, length: match[0].length, node: pattern.render(match) };
      }
    }
    if (!best) break;
    if (best.index > 0) out.push(rest.slice(0, best.index));
    key += 1;
    out.push(best.node);
    rest = rest.slice(best.index + best.length);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

interface Block {
  kind: "code" | "heading" | "list" | "paragraph";
  level?: number;
  ordered?: boolean;
  lang?: string;
  lines: string[];
}

/** Split raw markdown into block structures (fences first). */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      // An unterminated fence (mid-stream) renders as code so far.
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      blocks.push({ kind: "code", lang: fence[1] || undefined, lines: code });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, lines: [heading[2]!] });
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [listItem[1]!];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        const nextItem = next.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (!nextItem) break;
        items.push(nextItem[1]!);
        i += 1;
      }
      flushParagraph();
      blocks.push({ kind: "list", ordered, lines: items });
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export function Markdown({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "code") {
          return (
            <pre key={key} className="md-code" data-lang={block.lang ?? undefined}>
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        if (block.kind === "heading") {
          const Level = `h${Math.min(6, Math.max(1, block.level ?? 1))}` as "h1";
          return (
            <Level key={key} className="md-heading">
              {renderInline(block.lines[0] ?? "", key)}
            </Level>
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key} className="md-list">
              {block.lines.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={key} className="md-para">
            {block.lines.map((line, lineIndex) => (
              <span key={`${key}-${lineIndex}`}>
                {renderInline(line, `${key}-${lineIndex}`)}
                {lineIndex < block.lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}
