import { useCallback,useEffect,useState } from 'react'
import { api } from '../../app/api'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState } from '../../ui/ErrorState'
import { Pagination } from '../../ui/Pagination'
type Log={id:string;actor_user_id:string;action:string;target_type:string;target_id:string|null;created_at:string;detail:string}
export function AuditLogsPage() {
 const [logs,setLogs]=useState<Log[]>([]),[page,setPage]=useState(1),[pages,setPages]=useState(1),[action,setAction]=useState(''),[actor,setActor]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[error,setError]=useState('')
 const load=useCallback(async()=>{setError('');try{const query=new URLSearchParams({page:String(page),pageSize:'20',action,actor,...(from?{from:new Date(from).toISOString()}:{}),...(to?{to:new Date(to).toISOString()}:{})});const r=await api<{logs:Log[];pagination:{pageCount:number}}>(`/api/admin/audit-logs?${query}`);setLogs(r.logs);setPages(r.pagination.pageCount)}catch(e){setError(e instanceof Error?e.message:'加载失败')}},[page,action,actor,from,to])
 useEffect(()=>{void load()},[load])
 return <div className="page-stack"><PageHeader title="审计日志"/><section className="data-section"><div className="sys-grid"><label>操作<input value={action} onChange={e=>{setAction(e.target.value);setPage(1)}}/></label><label>管理员 ID<input value={actor} onChange={e=>{setActor(e.target.value);setPage(1)}}/></label><label>开始时间<input type="datetime-local" value={from} onChange={e=>{setFrom(e.target.value);setPage(1)}}/></label><label>结束时间<input type="datetime-local" value={to} onChange={e=>{setTo(e.target.value);setPage(1)}}/></label></div>
 {error?<ErrorState message={error} onRetry={()=>void load()}/>:null}
 <table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>目标</th><th>详情</th></tr></thead><tbody>{logs.map(l=><tr key={l.id}><td>{l.created_at}</td><td>{l.actor_user_id}</td><td>{l.action}</td><td>{l.target_type} / {l.target_id}</td><td>{l.detail}</td></tr>)}</tbody></table>{logs.length===0?<p>暂无日志</p>:null}<Pagination page={page} pageCount={pages} onPageChange={setPage}/></section></div>
}
