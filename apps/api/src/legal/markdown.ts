const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Shared existing legal Markdown subset; raw HTML is always escaped. */
export function renderLegalMarkdown(body: string): string {
  const inline = (s: string) => escape(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return body.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]!);
    if (heading && lines.length === 1) return `<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`;
    if (lines.every((l) => /^-\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^-\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}
