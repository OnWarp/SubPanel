import { BookOpen, Download, LayoutDashboard, FolderKanban, Gauge, Home, type LucideIcon, Megaphone, MessageSquare, Network, Rss, Send, Settings, Share2, SlidersHorizontal, ShieldCheck, UserRound, Users } from 'lucide-react'
import { matchPath } from 'react-router-dom'

export type NavItem = { to: string; label: string; icon: LucideIcon }
type NavSection = { label: string; items: NavItem[] }

export const adminSections: NavSection[] = [
  { label: '', items: [{ to: '/dashboard', label: '概览', icon: Gauge }] },
  { label: '资源', items: [
    { to: '/catalog/nodes', label: '节点', icon: Network },
    { to: '/catalog/sources', label: '来源', icon: Rss },
    { to: '/catalog/groups', label: '分组', icon: FolderKanban },
  ] },
  { label: '订阅', items: [
    { to: '/delivery/templates', label: '权益模板', icon: Send },
    { to: '/delivery/shares', label: '分享管理', icon: Share2 },
  ] },
  { label: '用户', items: [{ to: '/users', label: '用户管理', icon: Users }] },
  { label: '运营', items: [
    { to: '/delivery/tickets', label: '工单', icon: MessageSquare },
    { to: '/operations/notices', label: '公告', icon: Megaphone },
    { to: '/kb/manage', label: '知识库', icon: BookOpen },
    { to: '/catalog/apps', label: '客户端下载', icon: Download },
  ] },
  { label: '系统', items: [
    { to: '/system', label: '系统设置', icon: Settings },
    { to: '/audit-logs', label: '审计日志', icon: ShieldCheck },
  ] },
]

export type SectionTab = { to: string; label: string; includeChildren?: boolean }
type AdminDomain = NavItem & { shortLabel?: string; section?: { label: string; tabs: SectionTab[]; preserveSearch?: boolean } }

export const adminDomains: AdminDomain[] = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard },
  {
    to: '/catalog/nodes', label: '节点管理', shortLabel: '节点', icon: Network,
    section: { label: '节点管理导航', tabs: [
      { to: '/catalog/nodes', label: '节点' },
      { to: '/catalog/sources', label: '来源' },
      { to: '/catalog/groups', label: '分组' },
    ] },
  },
  {
    to: '/delivery/templates', label: '订阅管理', shortLabel: '订阅', icon: Send,
    section: { label: '订阅管理导航', tabs: [
      { to: '/delivery/templates', label: '权益模板' },
      { to: '/delivery/shares', label: '分享' },
      { to: '/delivery/redemptions', label: '兑换码' },
    ] },
  },
  {
    to: '/users', label: '用户管理', shortLabel: '用户', icon: Users,
    section: { label: '用户管理子页', preserveSearch: true, tabs: [
      { to: '/users', label: '用户', includeChildren: true },
      { to: '/invites', label: '邀请' },
      { to: '/users/recycle-bin', label: '回收站' },
    ] },
  },
  {
    to: '/delivery/tickets', label: '运营管理', shortLabel: '运营', icon: Megaphone,
    section: { label: '运营管理导航', tabs: [
      { to: '/delivery/tickets', label: '工单', includeChildren: true },
      { to: '/operations/notices', label: '公告' },
      { to: '/kb/manage', label: '知识库' },
      { to: '/catalog/apps', label: '客户端下载' },
    ] },
  },
  {
    to: '/system/registration', label: '系统设置', shortLabel: '设置', icon: SlidersHorizontal,
    section: { label: '系统设置导航', preserveSearch: true, tabs: [
      { to: '/system/registration', label: '注册设置' },
      { to: '/system/mail', label: '邮件设置' },
      { to: '/system/distribution', label: '订阅分发' },
      { to: '/system/status', label: '运行状态' },
      { to: '/audit-logs', label: '审计日志' },
    ] },
  },
]

/** Narrow dock only. Operations and system settings stay on the desktop sidebar and the narrow account menu. */
const adminMobileDockTargets = new Set(['/dashboard', '/catalog/nodes', '/delivery/templates', '/users'])
export const adminMobileDock = adminDomains.filter((domain) => adminMobileDockTargets.has(domain.to))

const contentModulePaths = new Set([
  '/users', '/invites', '/users/recycle-bin',
  '/catalog/nodes', '/catalog/sources', '/catalog/groups', '/catalog/apps',
  '/delivery/templates', '/delivery/shares', '/delivery/redemptions',
  '/system/registration', '/system/mail', '/system/distribution', '/system/status', '/audit-logs',
  '/delivery/tickets', '/operations/notices', '/kb/manage',
])

/** These list routes render ModuleTabs in the content page, so the shell must not repeat them. */
export function contentOwnsModuleTabs(path: string) {
  return contentModulePaths.has(path)
}

export function matchesSectionTab(tab: SectionTab, path: string) {
  if (tab.to === '/users' && path === '/users/recycle-bin') return false
  return Boolean(matchPath({ path: tab.to, end: !tab.includeChildren }, path))
}

export function adminDomainForPath(path: string) {
  return adminDomains.find(({ to, section }) => section
    ? section.tabs.some(tab => matchesSectionTab(tab, path))
    : matchPath(to, path))
}

export const userSidebar: NavItem[] = [
  { to: '/home', label: '首页', icon: Home },
  { to: '/subscriptions', label: '订阅', icon: Rss },
  { to: '/nodes', label: '节点', icon: Network },
  { to: '/me', label: '我的', icon: UserRound },
]

export function navigationActive(path: string, to: string) {
  if (to === '/users') return path === '/invites' || path === '/users' || path.startsWith('/users/')
  if (to === '/me') return !['/home', '/subscriptions', '/nodes'].includes(path)
  return path === to || path.startsWith(to + '/')
}
