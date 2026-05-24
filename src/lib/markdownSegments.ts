/**
 * Minimal markdown-aware splitter — separates code fences, GFM-style pipe
 * tables, and prose so a chat-text block can render rich markdown without
 * pulling a full markdown engine.
 *
 * Recognised fences (greedy match on opening, exact match on closing):
 *   ```lang
 *   ```lang:filename
 *   ```lang filename
 *
 * Recognised tables (GFM pipe form):
 *   | col | col |
 *   | --- | --- |
 *   | 1   | 55  |
 *
 * Inline `**bold**`, `*italic*`, and `` `code` `` inside prose are parsed
 * into typed inline runs (no {@html}).
 */
export type InlineRun =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

export type TextSegment =
  | { kind: "prose"; text: string; inline: InlineRun[] }
  | { kind: "code"; lang: string; filename: string; code: string }
  | { kind: "table"; header: string[]; rows: string[][] };

const FENCE_RE = /^```([^\s:]*)(?:[:\s]+([^\n]+?))?\s*$/;
// A pipe-table row: starts with optional ws then `|`, contains at least one `|`.
const TABLE_LINE = /^\s*\|.*\|\s*$/;
// Separator row: each cell is dashes (optionally :--- / :---: / ---: for align).
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export type ParseOptions = {
  /** Streaming messages should NOT treat an unclosed fence as code (the
   *  model is still typing the close). Final messages get the opposite
   *  behavior: render whatever the user / model wrote up to EOF as the
   *  code body. */
  streaming?: boolean;
};

function splitPipeRow(line: string): string[] {
  // Trim outer pipes/whitespace, split on `|`, trim each cell.
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Parse inline markdown (`**bold**`, `*italic*`, `` `code` ``) into typed
 * runs. Greedy, non-nesting — matches the common Claude-emitted style
 * without trying to be a full CommonMark engine.
 */
export function parseInline(text: string): InlineRun[] {
  if (!text) return [];
  const out: InlineRun[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    // Inline code: `...`  (single backtick, no newlines)
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold: **...**  (must check before single `*`)
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2 && text[i + 2] !== "*") {
        const inner = text.slice(i + 2, end);
        if (!inner.includes("\n") && inner.trim().length > 0) {
          flush();
          out.push({ kind: "strong", text: inner });
          i = end + 2;
          continue;
        }
      }
    }
    // Italic: *...*  (single asterisk, content must not start/end with space)
    if (ch === "*" && text[i + 1] !== "*") {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "*" && text[end - 1] !== "\\") break;
        if (text[end] === "\n") { end = -1; break; }
        end++;
      }
      if (end > i + 1 && end < text.length) {
        const inner = text.slice(i + 1, end);
        if (inner.trim().length > 0 && !/^\s|\s$/.test(inner)) {
          flush();
          out.push({ kind: "em", text: inner });
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseTextSegments(
  input: string,
  opts: ParseOptions = {},
): TextSegment[] {
  if (!input) return [{ kind: "prose", text: "", inline: [] }];
  const lines = input.split(/\r?\n/);
  const out: TextSegment[] = [];
  let proseBuf: string[] = [];
  let i = 0;

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    const text = proseBuf.join("\n");
    out.push({ kind: "prose", text, inline: parseInline(text) });
    proseBuf = [];
  };

  while (i < lines.length) {
    // Code fence detection
    const open = FENCE_RE.exec(lines[i]);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
      if (j >= lines.length) {
        if (opts.streaming) {
          proseBuf.push(lines[i]);
          i++;
          continue;
        }
        flushProse();
        out.push({
          kind: "code",
          lang: (open[1] ?? "").trim(),
          filename: (open[2] ?? "").trim(),
          code: lines.slice(i + 1).join("\n"),
        });
        return out;
      }
      flushProse();
      out.push({
        kind: "code",
        lang: (open[1] ?? "").trim(),
        filename: (open[2] ?? "").trim(),
        code: lines.slice(i + 1, j).join("\n"),
      });
      i = j + 1;
      continue;
    }

    // GFM pipe-table detection: header row + separator + 1+ data rows.
    if (
      TABLE_LINE.test(lines[i]) &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1])
    ) {
      const header = splitPipeRow(lines[i]);
      const rows: string[][] = [];
      let k = i + 2;
      while (
        k < lines.length &&
        lines[k].trim() !== "" &&
        TABLE_LINE.test(lines[k])
      ) {
        rows.push(splitPipeRow(lines[k]));
        k++;
      }
      if (rows.length > 0) {
        flushProse();
        out.push({ kind: "table", header, rows });
        i = k;
        continue;
      }
    }

    proseBuf.push(lines[i]);
    i++;
  }
  flushProse();
  return out;
}
