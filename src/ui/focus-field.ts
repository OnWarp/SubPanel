export function focusFirstField(root: ParentNode) {
  const scope = root.querySelector<HTMLElement>('.drawer-content, .sp-dialog-body') ?? root
  const field = Array.from(scope.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [role="combobox"]:not([disabled])',
  )).find(element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'))
  field?.focus({ preventScroll: true })
}
