/**
 * Does to a rendered subtree what Chrome's page translator does: every
 * non-blank text node is replaced by `<font><font>text</font></font>`, so the
 * text nodes React rendered are no longer in the document. React writes that
 * then use one of them as an anchor (`insertBefore`) or remove it fail exactly
 * as they do on a translated page.
 */
export function simulatePageTranslation(root: Node): number {
  const document = root.ownerDocument ?? (root as Document);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.nodeValue ?? "").trim()) texts.push(node as Text);
  }
  for (const text of texts) {
    const outer = document.createElement("font");
    const inner = document.createElement("font");
    inner.textContent = text.nodeValue;
    outer.append(inner);
    text.replaceWith(outer);
  }
  return texts.length;
}
