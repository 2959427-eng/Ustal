// Node24 native TS stripping; draft Markdown is derived from the same page source.
// No publication, config activation or external requests.
import { mkdir, writeFile } from "node:fs/promises";
import { titles, sections } from "../apps/api/src/legal/pages.ts";
const output = new URL("../docs/launch/legal/", import.meta.url);
await mkdir(output, { recursive: true });
for (const [page, title] of Object.entries(titles)) {
  const content = `# USTAL — ${title}\n\n**ПРОЕКТ. Не утверждён для публикации.**\n\nОператор: Ким Дмитрий Эдуардович, South Korea. Контакт: [USTAL_SUPPORT_EMAIL].\n\n` + sections(page).map(([heading, text]) => `## ${heading}\n\n${text}\n`).join("\n");
  await writeFile(new URL(`${page}.md`, output), content, "utf8");
}
