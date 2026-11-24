(() => {
  const key = 'subpanel.theme'
  const guestKey = 'subpanel:layout:guest:theme'
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const valid = (value) => value === 'system' || value === 'light' || value === 'dark'
  const read = (storageKey = key) => {
    try {
      const value = localStorage.getItem(storageKey)
      return valid(value) ? value : 'system'
    } catch {
      return 'system'
    }
  }
  const resolve = (preference) =>
    preference === 'light' || preference === 'dark'
      ? preference
      : media.matches
        ? 'dark'
        : 'light'
  const apply = (preference = read()) => {
    const mode = resolve(preference)
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
    return mode
  }

  window.subpanelTheme = { key, guestKey, media, read, resolve, apply }
  apply(read(guestKey))
})()
