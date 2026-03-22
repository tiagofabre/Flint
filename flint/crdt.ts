// @ts-ignore — subpath exports not visible to moduleResolution:node, resolved by esbuild
import * as Automerge from "@automerge/automerge/slim";
// @ts-ignore
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64.js";

export interface FlintDoc {
	text: string;
}

let _initPromise: Promise<void> | null = null;

export function initAutomerge(): Promise<void> {
	if (!_initPromise) {
		_initPromise = (Automerge as any).initializeBase64Wasm(automergeWasmBase64) as Promise<void>;
	}
	return _initPromise as Promise<void>;
}

export function createDoc(text: string): Automerge.Doc<FlintDoc> {
	let doc = Automerge.init<FlintDoc>();
	doc = Automerge.change(doc, (d: FlintDoc) => {
		d.text = text;
	});
	return doc;
}

export function loadDoc(bytes: Uint8Array): Automerge.Doc<FlintDoc> {
	return Automerge.load<FlintDoc>(bytes);
}

export function saveDoc(doc: Automerge.Doc<FlintDoc>): Uint8Array {
	return Automerge.save(doc);
}

export function updateDoc(
	doc: Automerge.Doc<FlintDoc>,
	newText: string
): Automerge.Doc<FlintDoc> {
	return Automerge.change(doc, (d: FlintDoc) => {
		d.text = newText;
	});
}

export function mergeDocs(
	local: Automerge.Doc<FlintDoc>,
	remote: Automerge.Doc<FlintDoc>
): { doc: Automerge.Doc<FlintDoc>; text: string } {
	const merged = Automerge.merge(Automerge.clone(local), remote);
	return { doc: merged, text: merged.text };
}

export function injectFlintId(markdownContent: string, id: string): string {
	const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
	const match = frontmatterRegex.exec(markdownContent);

	if (match) {
		const existingFrontmatter = match[1];
		if (existingFrontmatter.includes('_flint_id:')) {
			const updated = existingFrontmatter.replace(
				/_flint_id:.*(\r?\n|$)/,
				`_flint_id: ${id}$1`
			);
			return markdownContent.replace(frontmatterRegex, `---\n${updated}\n---`);
		} else {
			return markdownContent.replace(
				frontmatterRegex,
				`---\n${existingFrontmatter}\n_flint_id: ${id}\n---`
			);
		}
	} else {
		return `---\n_flint_id: ${id}\n---\n${markdownContent}`;
	}
}

export function extractFlintId(markdownContent: string): string | null {
	const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
	const match = frontmatterRegex.exec(markdownContent);
	if (!match) return null;

	const idMatch = /_flint_id:\s*(.+)/.exec(match[1]);
	if (!idMatch) return null;

	return idMatch[1].trim();
}
