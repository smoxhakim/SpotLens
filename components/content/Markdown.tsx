import Link from "next/link";

/**
 * Minimal markdown renderer for Learn articles.
 *
 * The content is authored in this repository, not user-supplied, so a full
 * markdown library would be weight for no benefit. It handles exactly the
 * subset the articles use — and because it builds React elements rather than
 * setting innerHTML, there is no HTML injection path even if content later
 * becomes editable.
 */
export function Markdown({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/);

  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        const key = `${i}-${block.slice(0, 16)}`;

        if (block.startsWith("## ")) {
          return (
            <h2 key={key} className="pt-2 text-sm font-semibold">
              {inline(block.slice(3))}
            </h2>
          );
        }

        if (block.startsWith("    ")) {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs"
            >
              {block.replace(/^ {4}/gm, "")}
            </pre>
          );
        }

        if (block.startsWith("| ")) {
          return <Table key={key} block={block} />;
        }

        if (/^[-*] /m.test(block) && block.split("\n").every((l) => /^[-*] /.test(l))) {
          return (
            <ul key={key} className="list-disc space-y-1 pl-5">
              {block.split("\n").map((line, j) => (
                <li key={j}>{inline(line.replace(/^[-*] /, ""))}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={key} className="text-muted-foreground">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}

function Table({ block }: { block: string }) {
  const rows = block
    .split("\n")
    .filter((line) => !/^\|[\s:-]+\|$/.test(line.replace(/\s/g, "")))
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );

  const [head, ...body] = rows;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b">
            {head.map((cell, i) => (
              <th key={i} className="px-2 py-1.5 text-left font-medium">
                {inline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 text-muted-foreground">
                  {inline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Handles **bold**, `code`, and [text](/internal/link). */
function inline(text: string): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern).filter(Boolean);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      // Internal links only: article bodies never point off-site.
      if (href.startsWith("/")) {
        return (
          <Link key={i} href={href} className="text-primary underline underline-offset-2">
            {label}
          </Link>
        );
      }
      return <span key={i}>{label}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}
