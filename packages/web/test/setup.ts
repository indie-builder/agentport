declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

globalThis.__UI_SDK_STRICT__ = true;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = () => {};
Element.prototype.checkVisibility = function (this: Element) {
  if (!this.isConnected || this.closest('[hidden]')) return false;
  for (let node: Element | null = this; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
};
Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[popover][data-open]{display:block !important}',
  }),
);
