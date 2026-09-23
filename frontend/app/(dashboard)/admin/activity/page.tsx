'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import api from '@/lib/api'
import Pagination from '@/components/Pagination'
import { History, Search, ChevronDown, ChevronRight } from 'lucide-react'

interface LogRow {
  id: string
  userId: string | null
  userEmail: string | null
  action: string
  label: string
  targetId: string | null
  ok: boolean
  statusCode: number
  detail: Record<string, any> | null
  ip: string | null
  createdAt: string
  user: { id: string; name: string; email: string } | null
}

interface UserOption {
  id: string
  name: string
}

const timeFmt = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Jakarta',
})

/** "120 order" from { count: 120 }, else the list's length — how big the action was. */
function sizeOf(detail: LogRow['detail']): string | null {
  const body = detail?.body
  if (!body || typeof body !== 'object') return null
  for (const v of Object.values(body)) {
    if (Array.isArray(v)) return `${v.length} item`
    if (v && typeof v === 'object' && typeof (v as any).count === 'number') return `${(v as any).count} item`
  }
  return null
}

export default function ActivityPage() {
  const [logs, setLogs] = useState<LogRow[]>([])
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)

  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')

  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    api.get<any>('/users')
      .then((res) => {
        const raw = Array.isArray(res.data) ? res.data : (res.data?.data || [])
        setUsers(raw.map((u: any) => ({ id: u.id, name: u.name })))
      })
      .catch(() => setUsers([]))
  }, [])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number> = { page, limit }
      if (userId) params.userId = userId
      if (from) params.from = from
      if (to) params.to = to
      if (failedOnly) params.failed = '1'
      if (q) params.q = q
      const res = await api.get<any>('/system/activity', { params })
      setLogs(res.data?.logs ?? [])
      setTotalPages(res.data?.totalPages ?? 1)
      setTotal(res.data?.total ?? 0)
      setRetentionDays(res.data?.retentionDays ?? null)
    } catch (err: any) {
      setLogs([])
      setError(err?.response?.data?.error || 'Log aktivitas tidak bisa dimuat')
    } finally {
      setLoading(false)
    }
  }, [page, limit, userId, from, to, failedOnly, q])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1) }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Log Aktivitas</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Siapa melakukan apa di OrderPro: login, atur pengiriman, cetak resi, ubah stok, hapus master, kelola user dan toko.
          {retentionDays ? ` Disimpan ${retentionDays} hari.` : ''}
        </p>
      </div>

      <div className="card p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <select
          value={userId}
          onChange={(e) => resetPage(setUserId)(e.target.value)}
          className="input"
          aria-label="Filter user"
        >
          <option value="">Semua user</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className="input" aria-label="Dari tanggal" />
        <input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className="input" aria-label="Sampai tanggal" />
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setQ(qInput.trim()); setPage(1) } }}
            onBlur={() => { if (qInput.trim() !== q) { setQ(qInput.trim()); setPage(1) } }}
            placeholder="Cari aksi / email…"
            className="input pl-9 w-full"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => resetPage(setFailedOnly)(e.target.checked)}
            className="rounded border-gray-300 dark:border-slate-600"
          />
          Hanya yang gagal
        </label>
      </div>

      {error && (
        <div className="rounded-lg border px-4 py-3 text-sm border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          loading={loading}
          unit="aktivitas"
          onPageChange={setPage}
          onLimitChange={(n) => { setLimit(n); setPage(1) }}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-800/60 text-left text-xs uppercase text-gray-500 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3 w-8"></th>
                <th className="px-4 py-3">Waktu</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Aksi</th>
                <th className="px-4 py-3">Hasil</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Memuat…</td></tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-gray-500 dark:text-slate-400">
                    <History className="w-8 h-8 mx-auto mb-2 text-gray-400 dark:text-slate-500" />
                    Belum ada aktivitas yang cocok.
                  </td>
                </tr>
              ) : logs.map((log) => {
                const open = expanded === log.id
                const size = sizeOf(log.detail)
                return (
                  <Fragment key={log.id}>
                    <tr
                      onClick={() => setExpanded(open ? null : log.id)}
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40"
                    >
                      <td className="px-4 py-3 text-gray-400">
                        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600 dark:text-slate-300">
                        {timeFmt.format(new Date(log.createdAt))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-gray-900 dark:text-slate-100">{log.user?.name ?? '—'}</div>
                        <div className="text-xs text-gray-500 dark:text-slate-400">{log.user?.email ?? log.userEmail ?? ''}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-900 dark:text-slate-100">
                        {log.label}
                        {size && <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">({size})</span>}
                      </td>
                      <td className="px-4 py-3">
                        {log.ok ? (
                          <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300">Berhasil</span>
                        ) : (
                          <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300">Gagal</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-gray-50/60 dark:bg-slate-800/30">
                        <td></td>
                        <td colSpan={4} className="px-4 py-3 space-y-2 text-xs text-gray-600 dark:text-slate-300">
                          {log.detail?.error && (
                            <p className="text-red-700 dark:text-red-300">Error: {String(log.detail.error)}</p>
                          )}
                          <p>
                            <span className="font-mono">{log.action}</span>
                            {log.targetId && <> · target <span className="font-mono">{log.targetId}</span></>}
                            {' '}· HTTP {log.statusCode}
                            {log.ip && <> · IP {log.ip}</>}
                          </p>
                          {(log.detail?.body || log.detail?.result || log.detail?.reason) && (
                            <pre className="whitespace-pre-wrap break-all rounded bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 p-2 max-h-64 overflow-auto">
                              {JSON.stringify(
                                { ...(log.detail?.reason ? { alasan: log.detail.reason } : {}),
                                  ...(log.detail?.body ? { input: log.detail.body } : {}),
                                  ...(log.detail?.result ? { hasil: log.detail.result } : {}) },
                                null,
                                2
                              )}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
