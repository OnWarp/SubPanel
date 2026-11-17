import { BookOpen, Download, FolderKanban, Gauge, Home, type LucideIcon, Megaphone, MessageSquare, Network, Rss, Send, Settings, Share2, ShieldCheck, UserRound, Users } from 'lucide-react'

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
    { to: '/delivery/subscriptions', label: '订阅管理', icon: Send },
    { to: '/delivery/shares', label: '分享管理', icon: Share2 },
    { to: '/plans', label: '权益计划', icon: ShieldCheck },
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
