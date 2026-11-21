export function focusFirstField(root: ParentNode) {
  const scope = root.querySelector<HTMLElement>('.drawer-content, .sp-dialog-body') ?? root
  const field = scope.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [role="combobox"]:not([disabled])',
  )
  field?.focus()
}
