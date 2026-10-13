// A tiny mustache-like template engine for rendering gondolin skill templates.
//
// Supported tags (delimited by `{{ ... }}`, names whitespace-trimmed):
//   {{ name }}            → interpolate stringify(context[name])
//   {{# name }} … {{/}}   → section included only when context[name] is truthy
//   {{^ name }} … {{/}}   → inverted section, included only when falsy
//   {{! … }}              → comment, removed
//
// Sections nest (same or different names). The engine is defensive and never
// throws on malformed input: a stray `{{` with no closing `}}` is treated as
// literal text, and an unmatched section close is ignored.

export type TemplateContext = Record<string, unknown>;

// Parsed template node.
type TextNode = { kind: "text"; value: string };
type VarNode = { kind: "var"; name: string };
type SectionNode = {
  kind: "section";
  name: string;
  inverted: boolean;
  inner: Node[];
};
type Node = TextNode | VarNode | SectionNode;

// Flat token produced by the tokenizer (before sections are nested).
type Token =
  | { kind: "text"; value: string }
  | { kind: "var"; name: string }
  | { kind: "open"; name: string; inverted: boolean }
  | { kind: "close" };

/**
 * Render a mustache-like `template` with `context`. See the module doc for the
 * supported tags. Never throws: malformed input degrades to literal text.
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  try {
    return render(parseTop(tokenize(template)), context);
  } catch {
    // Defensive: any unforeseen parse problem yields the raw template.
    return template;
  }
}

// Split `template` into a flat token list. Scans for `{{` and matches the next
// `}}`; a `{{` with no `}}` means the rest is literal text.
function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  const n = template.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: "text", value: template.slice(textStart, end) });
    }
  };

  while (i < n) {
    const open = template.indexOf("{{", i);
    if (open === -1) break; // the remainder is literal text
    const close = template.indexOf("}}", open + 2);
    if (close === -1) break; // stray `{{` — the rest is literal text

    flushText(open);
    const tag = template.slice(open + 2, close).trim();
    if (tag.startsWith("!")) {
      // Comment: no token.
    } else if (tag.startsWith("#")) {
      tokens.push({ kind: "open", name: tag.slice(1).trim(), inverted: false });
    } else if (tag.startsWith("^")) {
      tokens.push({ kind: "open", name: tag.slice(1).trim(), inverted: true });
    } else if (tag.startsWith("/")) {
      tokens.push({ kind: "close" });
    } else {
      tokens.push({ kind: "var", name: tag });
    }
    textStart = close + 2;
    i = close + 2;
  }
  flushText(n);
  return tokens;
}

// Top-level parse of the flat token list into a node tree. A section `open`
// consumes tokens until its matching `close` (via parseBody); a `close` with
// no enclosing open (unmatched) is ignored and parsing continues.
function parseTop(tokens: Token[]): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === "close") {
      i += 1;
      continue; // unmatched close at top level — ignore
    }
    if (tok.kind === "open") {
      const { nodes: inner, end } = parseBody(tokens, i + 1);
      nodes.push({
        kind: "section",
        name: tok.name,
        inverted: tok.inverted,
        inner,
      });
      i = end;
      continue;
    }
    nodes.push(
      tok.kind === "text"
        ? { kind: "text", value: tok.value }
        : { kind: "var", name: tok.name },
    );
    i += 1;
  }
  return nodes;
}

// Parse a section body starting just after its `open`. The first `close`
// encountered at this level ends the body (the matching close); nested opens
// are handled recursively before that.
function parseBody(
  tokens: Token[],
  i: number,
): { nodes: Node[]; end: number } {
  const nodes: Node[] = [];
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === "close") {
      return { nodes, end: i + 1 };
    }
    if (tok.kind === "open") {
      const { nodes: inner, end } = parseBody(tokens, i + 1);
      nodes.push({
        kind: "section",
        name: tok.name,
        inverted: tok.inverted,
        inner,
      });
      i = end;
      continue;
    }
    nodes.push(
      tok.kind === "text"
        ? { kind: "text", value: tok.value }
        : { kind: "var", name: tok.name },
    );
    i += 1;
  }
  return { nodes, end: i };
}

// Render a node tree against a context.
function render(nodes: Node[], context: TemplateContext): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
    } else if (node.kind === "var") {
      out += stringify(context[node.name]);
    } else {
      const truthy = isTruthy(context[node.name]);
      if (node.inverted ? !truthy : truthy) {
        out += render(node.inner, context);
      }
    }
  }
  return out;
}

// Value → display string. Missing/null → ""; arrays are comma-joined;
// booleans become "true"/"false"; everything else is String(v).
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// Section truthiness. Booleans as-is; non-null objects are true; arrays by
// length; numbers by !== 0; strings by length; null/undefined are false.
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}
