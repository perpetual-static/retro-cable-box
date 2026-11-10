#!/usr/bin/env node
/**
 * Builds the docs site (GitHub Pages) from the repo.
 *
 *   docs/pages/*.md      the pages; front matter gives the channel number and name
 *   docs/site.json       title, repo, shop link
 *   docs/theme/          the cable-guide theme
 *   docs/assets/         images
 *
 * Generated from the repo at build time:
 *   <!-- generated:tools -->  MCP tools, read from services/mcp/src/server.ts
 *   <!-- generated:bom -->    the parts table, from hardware/bom.csv
 *   <!-- generated:case -->   the case files in hardware/case/ (copied for download)
 *   <!-- generated:shop -->   the buy button, from site.json shopUrl
 *
 * Output: docs/_site. Run: pnpm docs:build
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const DOCS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DOCS, '..');
const OUT = join(DOCS, '_site');
const site = JSON.parse(readFileSync(join(DOCS, 'site.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── pages ────────────────────────────────────────────────────────────────────

function readPage(file) {
	const text = readFileSync(join(DOCS, 'pages', file), 'utf8');
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	if (!m) throw new Error(`${file}: no front matter`);
	const meta = Object.fromEntries(m[1].split('\n').map((l) => l.split(/:\s*/, 2)).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
	for (const k of ['num', 'name', 'title', 'slug']) if (!meta[k]) throw new Error(`${file}: front matter needs ${k}`);
	return { ...meta, num: Number(meta.num), body: text.slice(m[0].length) };
}

const pages = readdirSync(join(DOCS, 'pages'))
	.filter((f) => f.endsWith('.md'))
	.map(readPage)
	.sort((a, b) => a.num - b.num);

// ── generated sections ───────────────────────────────────────────────────────

/** MCP tools: name, title and description from each server.registerTool(...) call. */
function toolsSection() {
	const src = readFileSync(join(ROOT, 'services/mcp/src/server.ts'), 'utf8');
	const strings = (s) =>
		[...s.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
			.map((m) => (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1').replace(/\$\{MANIFEST_FILE\}/g, 'retro-cable-box.json'))
			.join('');
	const tools = [];
	const starts = [...src.matchAll(/server\.registerTool\(\s*'([a-z0-9_]+)',/g)];
	for (const m of starts) {
		// The tool's settings: from its name to its handler.
		const seg = src.slice(m.index + m[0].length, src.indexOf('async (', m.index));
		const t = /title:\s*(?:'([^']*)'|"([^"]*)")/.exec(seg);
		const title = t?.[1] ?? t?.[2] ?? m[1];
		const d = /description:\s*((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\s|\+)+)/.exec(seg);
		tools.push({ name: m[1], title, description: d ? strings(d[1]) : '' });
	}
	if (tools.length < 10) throw new Error(`found only ${tools.length} MCP tools; the parser needs a look`);
	const rows = tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><strong>${esc(t.title)}</strong><br>${esc(t.description)}</td></tr>`);
	return `<p>${tools.length} tools.</p>\n<table class="tools"><thead><tr><th>Tool</th><th>Does</th></tr></thead><tbody>\n${rows.join('\n')}\n</tbody></table>`;
}

function parseCsv(text) {
	const rows = [];
	for (const line of text.trim().split(/\r?\n/)) {
		const cells = [];
		let cur = '';
		let q = false;
		for (const ch of line) {
			if (ch === '"') q = !q;
			else if (ch === ',' && !q) {
				cells.push(cur);
				cur = '';
			} else cur += ch;
		}
		cells.push(cur);
		rows.push(cells.map((c) => c.trim()));
	}
	const [head, ...body] = rows;
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function bomSection() {
	const parts = parseCsv(readFileSync(join(ROOT, 'hardware/bom.csv'), 'utf8'));
	const sum = (list) => list.reduce((n, p) => n + Number(p.approx_usd || 0) * Number(p.qty || 1), 0);
	const required = parts.filter((p) => p.required === 'yes');
	const row = (p) =>
		`<tr><td>${p.link ? `<a href="${esc(p.link)}">${esc(p.part)}</a>` : esc(p.part)}${
			p.alt_link ? ` <a class="dim" href="${esc(p.alt_link)}">(also)</a>` : ''
		}</td><td class="n">${esc(p.qty)}</td><td class="n">$${esc(p.approx_usd)}</td><td>${esc(p.notes)}</td></tr>`;
	return [
		'<table class="bom"><thead><tr><th>Part</th><th class="n">Qty</th><th class="n">About</th><th>Notes</th></tr></thead><tbody>',
		...required.map(row),
		`<tr class="total"><td>Required parts</td><td></td><td class="n">$${sum(required)}</td><td></td></tr>`,
		'<tr class="sub"><td colspan="4">OPTIONAL</td></tr>',
		...parts.filter((p) => p.required !== 'yes').map(row),
		'</tbody></table>'
	].join('\n');
}

const CASE_EXT = new Set(['.stl', '.3mf', '.step', '.stp']);
function caseSection() {
	const dir = join(ROOT, 'hardware/case');
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => CASE_EXT.has(extname(f).toLowerCase())).sort() : [];
	if (!files.length) return '<p class="notice">The case files are not published yet. They will appear here when they are in <code>hardware/case/</code>.</p>';
	mkdirSync(join(OUT, 'case'), { recursive: true });
	const items = files.map((f) => {
		cpSync(join(dir, f), join(OUT, 'case', f));
		const kb = Math.round(statSync(join(dir, f)).size / 1024);
		return `<li><a href="case/${encodeURIComponent(f)}" download>${esc(f)}</a> <span class="dim">${extname(f).slice(1).toUpperCase()} · ${kb} KB</span></li>`;
	});
	const printing = existsSync(join(dir, 'PRINTING.md')) ? marked.parse(readFileSync(join(dir, 'PRINTING.md'), 'utf8')) : '';
	return `<ul class="files">${items.join('')}</ul>${printing}`;
}

function shopSection() {
	if (site.shopUrl) return `<p><a class="button" href="${esc(site.shopUrl)}">${esc(site.shopLabel || 'BUY NOW')}</a></p>`;
	return '<p class="notice">COMING SOON. The box will be for sale through Shop. Until then, you can <a href="build.html">build one</a>.</p>';
}

const GENERATED = { tools: toolsSection, bom: bomSection, case: caseSection, shop: shopSection };

// ── render ───────────────────────────────────────────────────────────────────

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const template = readFileSync(join(DOCS, 'theme/page.html'), 'utf8');

/** Heading ids that match the links in the pages ("1. Home network" → "1-home-network"). */
marked.use({
	renderer: {
		heading({ tokens, depth }) {
			const text = this.parser.parseInline(tokens);
			const id = text.replace(/<[^>]+>/g, '').toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
			return `<h${depth} id="${id}">${text}</h${depth}>\n`;
		}
	}
});

for (const p of pages) {
	let body = p.body;
	for (const [k, fn] of Object.entries(GENERATED)) {
		const tag = `<!-- generated:${k} -->`;
		if (body.includes(tag)) body = body.replace(tag, fn());
	}
	const nav = pages
		.map((q) => `<a class="row${q.slug === p.slug ? ' on' : ''}" href="${q.slug}.html"><span class="n">${q.num}</span><span class="nm">${esc(q.name)}</span></a>`)
		.join('\n');
	const html = template
		.replaceAll('{{title}}', esc(p.slug === 'index' ? `${site.title} · ${p.title}` : `${p.title} · ${site.title}`))
		.replaceAll('{{site}}', esc(site.title))
		.replaceAll('{{tagline}}', esc(site.tagline))
		.replaceAll('{{repo}}', esc(site.repo))
		.replaceAll('{{num}}', String(p.num))
		.replaceAll('{{name}}', esc(p.name))
		.replace('{{nav}}', nav)
		.replace('{{content}}', marked.parse(body));
	writeFileSync(join(OUT, `${p.slug}.html`), html);
}

cpSync(join(DOCS, 'theme/style.css'), join(OUT, 'style.css'));
if (existsSync(join(DOCS, 'assets'))) cpSync(join(DOCS, 'assets'), join(OUT, 'assets'), { recursive: true });
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`docs: ${pages.length} pages → ${OUT}`);
