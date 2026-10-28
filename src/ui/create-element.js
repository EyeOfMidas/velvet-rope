/** Tiny element builder: createElement('p', { className: 'x', dataset: { testid: 'y' } }, 'text', child). */
export function createElement(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(el, rest);
  Object.assign(el.dataset, dataset);
  el.append(...children);
  return el;
}

/** An element screen readers announce: role=alert for errors, role=status for progress. */
export function announced(tag, role, className) {
  const el = createElement(tag, { className, hidden: role === 'alert' });
  el.setAttribute('role', role);
  return el;
}
