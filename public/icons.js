const SVG_NS = "http://www.w3.org/2000/svg";

/** Decorative UI icons inherit color; the containing control provides its name. */
export function createIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(element, name) {
  element.replaceChildren(createIcon(name));
}
