// Marks the edges of a scroller that have more behind them, for the fades
// that say so: the home screen's rows across (more-left, more-right) and the
// settings sheet down (more-above, more-below). The classes go on `marked`,
// which holds the fades; content fills after load, grows, and resizes with
// the window.

const CLASSES = {
  x: ["more-left", "more-right"],
  y: ["more-above", "more-below"],
};

export function trackScrollEdges(scroller, { marked = scroller, axis = "x" } = {}) {
  const [before, after] = CLASSES[axis];
  const update = () => {
    const position = axis === "x" ? scroller.scrollLeft : scroller.scrollTop;
    const end = axis === "x" ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollHeight - scroller.clientHeight;
    // Slack for the fractional scroll positions a zoomed page leaves.
    marked.classList.toggle(before, position > 2);
    marked.classList.toggle(after, position < end - 2);
  };
  scroller.addEventListener("scroll", update, { passive: true });
  const resized = new ResizeObserver(update);
  resized.observe(scroller);
  // Down the sheet, a group that grows changes how far it scrolls without
  // resizing the scroller.
  const watch = (node) => axis === "y" && node.nodeType === 1 && resized.observe(node);
  for (const child of scroller.children) watch(child);
  new MutationObserver((changes) => {
    for (const change of changes) for (const node of change.addedNodes) if (node.parentNode === scroller) watch(node);
    update();
  }).observe(scroller, { childList: true });
  update();
  return update;
}
