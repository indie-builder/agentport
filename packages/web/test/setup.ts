Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (typeof Element.prototype.getAnimations !== 'function') {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: () => [],
  });
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[popover][data-open]{display:block !important}',
  }),
);

if (typeof Element.prototype.checkVisibility !== 'function') {
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    writable: true,
    value(this: Element) {
      if (!this.isConnected || this.closest('[hidden]')) return false;
      for (let node: Element | null = this; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    },
  });
}
