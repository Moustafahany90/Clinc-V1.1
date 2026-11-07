/**
 * Frontend helpers for the edit mode HTML produced by renderReportHtml({mode:'edit'}).
 * The HTML has no scripts; the host page (same-origin iframe) reads the values
 * back with collectContent and wires basic editing behaviour with attachEditHandlers.
 */

const plain = (value: string | null): string => (value ?? '').replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ');

/**
 * Reads every [data-key] control under `root` and returns the new content.
 * `base` is copied first so keys that are not part of the template survive.
 */
export function collectContent(
  root: ParentNode,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const checklists: Record<string, Record<string, string>> = {};
  root.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    if (!key) return;
    const sub = el.dataset.sub;
    if (sub) {
      (checklists[key] ??= {})[sub] = plain(el.textContent);
    } else if (el.tagName === 'SELECT') {
      out[key] = (el as HTMLSelectElement).value;
    } else if (el.dataset.kind === 'list') {
      out[key] = Array.from(el.querySelectorAll('li'))
        .map((li) => plain(li.textContent).trim())
        .filter(Boolean);
    } else {
      out[key] = plain(el.textContent);
    }
  });
  for (const [key, value] of Object.entries(checklists)) out[key] = value;
  return out;
}

/**
 * Plain-text paste everywhere, Enter disabled in single line fields.
 * Returns a cleanup function. `onChange` fires after every edit.
 */
export function attachEditHandlers(doc: Document, onChange: () => void): () => void {
  const editable = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[contenteditable="true"]') : null;

  const onPaste = (event: ClipboardEvent) => {
    if (!editable(event.target)) return;
    event.preventDefault();
    const text = plain(event.clipboardData?.getData('text/plain') ?? '');
    doc.execCommand('insertText', false, text);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const el = editable(event.target);
    if (el && event.key === 'Enter' && el.dataset.kind !== 'list') event.preventDefault();
  };
  const onInput = () => onChange();
  const onSelect = (event: Event) => {
    if (event.target instanceof HTMLSelectElement) onChange();
  };

  doc.addEventListener('paste', onPaste);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('input', onInput);
  doc.addEventListener('change', onSelect);
  return () => {
    doc.removeEventListener('paste', onPaste);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('input', onInput);
    doc.removeEventListener('change', onSelect);
  };
}
