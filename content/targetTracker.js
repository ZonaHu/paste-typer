// Remember page targets, never the controls hosted in our Shadow DOM.
class TargetTracker {
  constructor() {
    this.element = null;
    this.selection = null;
    this.changedAt = 0;
    document.addEventListener('focusin', e => this.capture(e.target), true);
    document.addEventListener('focusout', e => this.capture(e.target), true);
    document.addEventListener('selectionchange', () => this.capture(document.activeElement));
    document.addEventListener('keyup', e => this.capture(e.target), true);
    document.addEventListener('pointerup', e => this.capture(e.target), true);
    this.capture(document.activeElement);
  }

  isEditable(element) {
    if (!element || !element.isConnected || element.closest('#paste-typer-floating-ui') ||
        element.closest('[inert]') || element.matches(':disabled')) return false;
    const native = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    if (native ? element.readOnly || !['text', 'email', 'password', 'search', 'url', 'tel', 'textarea', ''].includes(element.type)
        : !element.isContentEditable) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    for (let current = element; current; current = current.parentElement) {
      const computed = getComputedStyle(current);
      if (computed.display === 'none' || computed.contentVisibility === 'hidden' || Number(computed.opacity) === 0) return false;
    }
    return true;
  }

  capture(element) {
    if (!this.isEditable(element)) return;
    this.element = element;
    this.changedAt = Date.now();
    if (typeof element.selectionStart === 'number') {
      this.selection = { start: element.selectionStart, end: element.selectionEnd,
        direction: element.selectionDirection };
    } else {
      const selection = window.getSelection();
      this.selection = selection.rangeCount && element.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange() : null;
    }
  }

  getTarget() {
    return this.isEditable(this.element) ? this.element : null;
  }

  restore(element) {
    const saved = element === this.element ? this.selection : null;
    element.focus({ preventScroll: true });
    if (!saved) return;
    if (typeof saved.start === 'number') {
      element.setSelectionRange(saved.start, saved.end, saved.direction);
    } else if (saved.startContainer.isConnected && saved.endContainer.isConnected) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(saved);
    }
  }
}

const targetTracker = new TargetTracker();
