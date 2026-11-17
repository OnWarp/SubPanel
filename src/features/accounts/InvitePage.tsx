import { Navigate, useParams } from 'react-router-dom'

export function InvitePage() {
  const { token = '' } = useParams()
  return <Navigate to={`/register?inviteCode=${encodeURIComponent(token)}`} replace />
}
