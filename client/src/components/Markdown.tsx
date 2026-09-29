/**
 * Small dependency-free markdown renderer.
 *
 * Why hand-rolled: the bundle must stay light for low-end Android devices (spec §26), and AI
 * answers only need a tight subset — headings, lists, bold/italic, inline code, fenced code and
 * blockquotes. Everything is rendered as React nodes, so there is no dangerouslySetInnerHTML and
 * therefore no HTML-injection surface from model output.
 */
import { memo, useState, type ReactNode } from 'react';

interface Token {
  type: 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'rule';
  level?: number;
  ordered?: boolean;
  items?: string[];
  text?: string;
  lang?: string;
}

function tokenize(markdown: string): Token[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const tokens: Token[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // fenced code
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      tokens.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      tokens.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[-\s*_]*$/.test(line)) {
      tokens.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      tokens.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    // lists
    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const nextBullet = /^\s*[-*+•]\s+(.*)$/.exec(current);
        const nextNumbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(current);
        if (ordered && nextNumbered) items.push(nextNumbered[2]);
        else if (!ordered && nextBullet) items.push(nextBullet[1]);
        else if (/^\s{2,}\S/.test(current) && items.length) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      tokens.push({ type: 'list', ordered, items });
      continue;
    }

    // paragraph (collect until blank line / next block start)
    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+•]\s|\d+[.)]\s)/.test(lines[index])
    ) {
      body.push(lines[index]);
      index += 1;
    }
    if (body.length) tokens.push({ type: 'paragraph', text: body.join('\n') });
    else index += 1;
  }

  return tokens;
}

/** Inline formatting: **bold**, *italic*, `code`, [text](url), bare URLs. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let counter = 0;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${counter++}`;

    if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-[var(--color-text)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[0.86em] text-[#a5f3fc]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--color-primary-soft)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-primary)]"
          >
            {link[1]}
          </a>,
        );
      }
    } else if (token.startsWith('http')) {
      nodes.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-[var(--color-primary-soft)] underline decoration-dotted underline-offset-2"
        >
          {token}
        </a>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic text-[var(--color-text)]/90">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2.5 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[#070C11]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">{lang || 'code'}</span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-[var(--color-muted)] transition-colors hover:bg-white/5 hover:text-[var(--color-text)]"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="vroqn-scroll-x px-3 py-2.5 text-[12.5px] leading-relaxed">
        <code className="font-mono text-[#cbe9f5]">{code}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content, className = '' }: { content: string; className?: string }) {
  const tokens = tokenize(content ?? '');
  return (
    <div className={`text-[14px] leading-[1.72] text-[var(--color-text)]/95 ${className}`}>
      {tokens.map((token, index) => {
        switch (token.type) {
          case 'heading': {
            const level = token.level ?? 1;
            const sizes = ['text-[17px]', 'text-[16px]', 'text-[15px]', 'text-[14px]', 'text-[13.5px]', 'text-[13px]'];
            return (
              <h3
                key={index}
                className={`mt-4 mb-1.5 font-semibold text-[var(--color-text)] first:mt-0 ${sizes[level - 1]}`}
              >
                {inline(token.text ?? '', `h${index}`)}
              </h3>
            );
          }
          case 'paragraph':
            return (
              <p key={index} className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">
                {inline(token.text ?? '', `p${index}`)}
              </p>
            );
          case 'list':
            return token.ordered ? (
              <ol key={index} className="my-2 list-decimal space-y-1 pl-5 marker:text-[var(--color-primary)]/80">
                {token.items?.map((item, i) => (
                  <li key={i} className="pl-0.5">
                    {inline(item, `ol${index}-${i}`)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={index} className="my-2 space-y-1 pl-4">
                {token.items?.map((item, i) => (
                  <li key={i} className="relative pl-3">
                    <span aria-hidden="true" className="absolute left-0 top-[0.62em] h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]/70" />
                    {inline(item, `ul${index}-${i}`)}
                  </li>
                ))}
              </ul>
            );
          case 'code':
            return <CodeBlock key={index} code={token.text ?? ''} lang={token.lang} />;
          case 'quote':
            return (
              <blockquote
                key={index}
                className="my-2 border-l-2 border-[var(--color-primary)]/40 bg-white/[0.02] py-1.5 pl-3 text-[13.5px] text-[var(--color-muted)]"
              >
                {inline(token.text ?? '', `q${index}`)}
              </blockquote>
            );
          case 'rule':
            return <hr key={index} className="my-4 border-[var(--color-border)]" />;
          default:
            return null;
        }
      })}
    </div>
  );
});
