// @ts-ignore — subpath exports not visible to moduleResolution:node, resolved by esbuild
import * as Automerge from "@automerge/automerge/slim";
// @ts-ignore
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64.js";

export interface FlintDoc {
	text: string;
}

// Opaque handle for an Automerge document — callers treat this as a black box.
export type FlintAutomergeDoc = { readonly __brand: 'FlintAutomergeDoc' };

// Local interface for the Automerge slim build — the slim build has no accessible
// type declarations via moduleResolution:node, so we cast once here.
interface AutomergeAPI {
	initializeBase64Wasm(b64: string): Promise<void>;
	init<T>(): T;
	change<T>(doc: T, fn: (d: T) => void): T;
	load<T>(bytes: Uint8Array): T;
	save<T>(doc: T): Uint8Array;
	merge<T>(target: T, source: T): T;
	clone<T>(doc: T): T;
}
const AM = Automerge as unknown as AutomergeAPI;

let _initPromise: Promise<void> | null = null;

export function initAutomerge(): Promise<void> {
	if (!_initPromise) {
		_initPromise = AM.initializeBase64Wasm(automergeWasmBase64 as string);
	}
	return _initPromise;
}

export function createDoc(text: string): FlintAutomergeDoc {
	let doc = AM.init<FlintDoc>();
	doc = AM.change(doc, (d: FlintDoc) => { d.text = text; });
	return doc as unknown as FlintAutomergeDoc;
}

export function loadDoc(bytes: Uint8Array): FlintAutomergeDoc {
	return AM.load<FlintDoc>(bytes) as unknown as FlintAutomergeDoc;
}

export function saveDoc(doc: FlintAutomergeDoc): Uint8Array {
	return AM.save(doc as unknown as FlintDoc);
}

export function updateDoc(doc: FlintAutomergeDoc, newText: string): FlintAutomergeDoc {
	return AM.change(doc as unknown as FlintDoc, (d: FlintDoc) => { d.text = newText; }) as unknown as FlintAutomergeDoc;
}

export function getDocText(doc: FlintAutomergeDoc): string {
	return (doc as unknown as FlintDoc).text;
}

export function mergeDocs(
	local: FlintAutomergeDoc,
	remote: FlintAutomergeDoc,
): { doc: FlintAutomergeDoc; text: string } {
	const merged = AM.merge(AM.clone(local as unknown as FlintDoc), remote as unknown as FlintDoc);
	return { doc: merged as unknown as FlintAutomergeDoc, text: merged.text };
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
