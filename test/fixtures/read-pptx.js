// read-pptx.js — an INDEPENDENT reader for the exported .pptx (tests only): a strict zip parse with
// node:zlib (not the jszip that wrote it; every entry's size and CRC-32 checked), every XML part checked
// well-formed (balanced tags, no character XML 1.0 forbids), every slide part declared in
// [Content_Types].xml and reached through presentation.xml's relationships, then the slides' text and
// notes out of the OOXML. A file this can't read is not a valid PowerPoint package.

import { inflateRawSync, crc32 } from "node:zlib";

/** Every entry of a zip, by name → Buffer. Throws on anything that is not a well-formed zip. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf-8");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (data === null) throw new Error(`unsupported compression ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) >>> 0 !== buf.readUInt32LE(p + 16)) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** Throws unless `xml` is well-formed enough for an Office reader: balanced, properly nested tags; legal characters. */
export function checkXml(name, xml) {
  if (FORBIDDEN.test(xml)) throw new Error(`${name}: a character XML 1.0 forbids`);
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml)) throw new Error(`${name}: an unescaped "&"`);
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<|>/g)) {
    if (m[0] === "<") throw new Error(`${name}: a stray "<"`);
    if (m[0] === ">") continue; // a literal ">" in text is legal XML
    const [, close, tag, , self] = m;
    if (close) {
      if (stack.pop() !== tag) throw new Error(`${name}: </${tag}> closes nothing open`);
    } else if (!self) stack.push(tag);
  }
  if (stack.length !== 0) throw new Error(`${name}: <${stack.at(-1)}> never closes`);
}

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** A shape tree's paragraphs, per shape: `[[para text, …], …]`. */
function shapes(xml) {
  return [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map(([, sp]) =>
    [...sp.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(([, para]) =>
      unxml([...para.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(""))));
}

/**
 * The deck as the file holds it: `{ files, slides: [{ texts: [shape text], notes }] }` in presentation order
 * (presentation.xml's slide list, resolved through its relationships).
 */
export function readPptx(buf) {
  const files = readZip(buf);
  const must = (name) => {
    if (!files.has(name)) throw new Error(`missing ${name}`);
    return files.get(name).toString("utf-8");
  };
  for (const [name, data] of files) if (/\.(xml|rels)$/.test(name)) checkXml(name, data.toString("utf-8"));
  const types = must("[Content_Types].xml");
  const pres = must("ppt/presentation.xml");
  const rels = must("ppt/_rels/presentation.xml.rels");
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) =>
    [/Id="([^"]+)"/.exec(tag)[1], /Target="([^"]+)"/.exec(tag)[1]]));
  const order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => `ppt/${target.get(m[1]).replace(/^\/?ppt\//, "")}`);
  if (order.length === 0) throw new Error("presentation.xml lists no slides");
  const slides = order.map((path) => {
    if (!types.includes(`PartName="/${path}"`)) throw new Error(`${path} is not declared in [Content_Types].xml`);
    const xml = must(path);
    const relPath = path.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
    const srels = files.has(relPath) ? files.get(relPath).toString("utf-8") : "";
    const notesRef = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(srels);
    let notes = "";
    if (notesRef) {
      const nx = must(`ppt/notesSlides/${notesRef[1]}`);
      // The notes page holds the slide image, the notes body and a slide number: the notes are the body's text.
      const body = [...nx.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].find(([, sp]) => /<p:ph type="body"/.test(sp));
      notes = body ? shapes(body[0]).flat().join("\n").replace(/\r\n/g, "\n") : "";
    }
    return { texts: shapes(xml).map((paras) => paras.join("\n")), notes };
  });
  return { files, slides };
}
