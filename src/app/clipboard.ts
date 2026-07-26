export async function copyToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // Fall back for clients that expose Clipboard API but deny its permission.
  }

  const input = document.createElement('textarea')
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  document.body.append(input)
  try {
    input.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    input.remove()
    previous?.focus()
  }
}
