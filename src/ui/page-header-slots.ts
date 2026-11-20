import { createContext } from 'react'

export const PageHeaderSlots = createContext<{ title: HTMLElement | null; actions: HTMLElement | null } | null>(null)
