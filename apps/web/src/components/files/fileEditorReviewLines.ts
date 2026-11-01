const REVIEW_LINE_ATTRIBUTE = "data-edit-review-line";

export const REVIEW_LINE_UNSAFE_CSS = `
[${REVIEW_LINE_ATTRIBUTE}] { background-color: color-mix(in srgb, var(--diffs-addition-base, #16a34a) 16%, transparent); }
`;

/** Tints unreviewed lines on the rows the virtualizer has rendered. Runs on each post-render. */
export function markReviewLines(fileContainer: HTMLElement, lines: ReadonlyArray<number>): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  const reviewed = new Set(lines);
  for (const element of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(element.dataset.line);
    element.toggleAttribute(REVIEW_LINE_ATTRIBUTE, reviewed.has(line));
  }
}
