// Bricks for a multi-column grid: each child gets --span, its height plus the
// column gap in px. The stylesheet turns that into a span of 1px rows and
// dense placement drops every child into the column that ends highest, so a
// short layer leaves no hole under it. One column ignores --span.
export function masonry(container) {
  if (typeof ResizeObserver === "undefined") return { destroy() {} };
  const fit = (node) => {
    const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
    node.style.setProperty("--span", String(Math.ceil(node.getBoundingClientRect().height + gap)));
  };
  const sizes = new ResizeObserver((entries) => entries.forEach((e) => fit(e.target)));
  [...container.children].forEach((c) => sizes.observe(c));
  return {
    destroy() {
      sizes.disconnect();
    },
  };
}
