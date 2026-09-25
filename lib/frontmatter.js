'use strict';

/**
 * Minimal YAML-subset parser for unit frontmatter. It supports exactly what the four
 * unit kinds need and throws on anything deeper, so a malformed unit fails the build
 * instead of silently losing a field:
 *   key: value          scalar (quotes stripped);  key: [a, b]  inline list
 *   key: > / key: |     block scalar over the following indented lines
 *   key:                one-level map        key:            list of scalars
 *     sub: value                               - value
 *   key:                list of single-key maps (workflow steps)
 *     - agent: name
 */
const KV = /^([A-Za-z0-9_-]+):\s*(.*)$/;

function parseFrontmatter(md) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!match) return { frontmatter: {}, body: md.trim() };
  const [, raw, body] = match;
  return { frontmatter: parseLines(raw.split(/\r?\n/)), body: body.trim() };
}

/**
 * The same one-level-deep grammar as `parseFrontmatter`, applied to a whole file with no
 * `---` delimiters — what `claude plugin eval`'s `case.yaml` actually is (a plain YAML
 * document, never markdown-with-frontmatter; wrapping it in `---` breaks the native parser).
 */
function parseYamlDocument(text) {
  return parseLines(text.split(/\r?\n/));
}

function parseLines(lines) {
  const isBlank = (l) => l.trim() === '' || l.trim().startsWith('#');
  const fm = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (/^\s/.test(line)) throw new Error(`frontmatter line ${i + 1} is indented but belongs to no key: "${line.trim()}"`);
    const kv = KV.exec(line);
    if (!kv) throw new Error(`cannot parse frontmatter line ${i + 1}: "${line}"`);
    const [, key, valueRaw] = kv;
    const value = valueRaw.trim();

    if (/^[|>][+-]?$/.test(value)) {
      const collected = [];
      i++;
      while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
        collected.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      fm[key] = value[0] === '>'
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n');
      continue;
    }

    if (value !== '') { fm[key] = parseScalar(value); i++; continue; }

    const block = [];
    i++;
    while (i < lines.length && (isBlank(lines[i]) || /^\s/.test(lines[i]))) {
      if (!isBlank(lines[i])) block.push(lines[i]);
      i++;
    }
    fm[key] = parseBlock(key, block);
  }
  return fm;
}

function parseBlock(key, block) {
  if (block.length === 0) return null;
  const indent = /^\s*/.exec(block[0])[0].length;
  const isList = block[0].trim().startsWith('- ');
  const out = isList ? [] : {};
  for (const line of block) {
    const lead = /^\s*/.exec(line)[0].length;
    if (lead > indent) throw new Error(`frontmatter key "${key}" nests too deep — this parser supports one level`);
    const text = line.trim();
    if (isList !== text.startsWith('- ')) throw new Error(`frontmatter key "${key}" mixes list items and map keys`);
    if (isList) {
      const item = text.slice(2).trim();
      const m = KV.exec(item);
      if (m && m[2].trim() === '') throw new Error(`frontmatter key "${key}" nests too deep — list items must be "- value" or "- key: value"`);
      out.push(m ? { [m[1]]: parseScalar(m[2].trim()) } : parseScalar(item));
    } else {
      const m = KV.exec(text);
      if (!m) throw new Error(`cannot parse frontmatter line under "${key}": "${text}"`);
      if (m[2].trim() === '') throw new Error(`frontmatter key "${key}.${m[1]}" nests too deep — keep values flat`);
      out[m[1]] = parseScalar(m[2].trim());
    }
  }
  return out;
}

function parseScalar(s) {
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => stripQuotes(x.trim())).filter(Boolean);
  }
  return stripQuotes(s);
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

module.exports = { parseFrontmatter, parseYamlDocument };
