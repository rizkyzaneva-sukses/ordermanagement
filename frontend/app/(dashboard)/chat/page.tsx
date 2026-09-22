'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import {
  AlertTriangle, ArrowLeft, ImagePlus, Loader2, MessageCircle, Package, RefreshCw, Send, Truck,
} from 'lucide-react'

interface Conversation {
  id: string
  storeId: string
  storeName: string
  buyerId: string
  buyerName: string
  avatar: string | null
  unread: number
  pinned: boolean
  lastMessage: string
  lastMessageId: string | null
  awaitingReply: boolean
  lastAt: number | null
}

interface Message {
  id: string
  type: string
  fromShop: boolean
  text: string | null
  imageUrl: string | null
  orderSn: string | null
  itemId: string | null
  preview: string
  createdAt: number | null
  status: string | null
  source: string | null
  sentBy: string | null
}

interface BuyerOrder {
  id: string
  orderId: string
  packageNumber: string
  status: string
  logisticsStatus: string | null
  courier: string
  trackingNumber: string | null
  orderDate: string
  shipByDate: string | null
  printedAt: string | null
  buyerNote: string | null
  items: { name: string; variant: string | null; qty: number }[]
}

/** Shopee's own limit on one text message. */
const MAX_TEXT = 600
const LIST_POLL_MS = 30_000
const THREAD_POLL_MS = 15_000

const WIB = 'Asia/Jakarta'

/** "14.05" today, "22 Sep" otherwise — in WIB, whatever the browser's zone. */
function shortTime(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const day = (x: Date) => x.toLocaleDateString('id-ID', { timeZone: WIB })
  return day(d) === day(new Date())
    ? d.toLocaleTimeString('id-ID', { timeZone: WIB, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('id-ID', { timeZone: WIB, day: 'numeric', month: 'short' })
}

function fullTime(ms: number | string | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString('id-ID', {
    timeZone: WIB, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function readError(err: any): { text: string; code?: string } {
  const body = err?.response?.data
  return { text: body?.error || err?.message || 'Terjadi kesalahan', code: body?.code }
}

const STATUS_LABEL: Record<string, string> = {
  UNPAID: 'Belum Bayar',
  READY_TO_SHIP: 'Perlu Dikirim',
  PROCESSED: 'Diproses',
  RETRY_SHIP: 'Kirim Ulang',
  SHIPPED: 'Dikirim',
  TO_CONFIRM_RECEIVE: 'Dikirim',
  COMPLETED: 'Selesai',
  CANCELLED: 'Batal',
  IN_CANCEL: 'Proses Batal',
  TO_RETURN: 'Retur',
}

/** Merge a fresh page into what is shown, oldest first, no duplicates. */
function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, { ...byId.get(m.id), ...m, sentBy: m.sentBy ?? byId.get(m.id)?.sentBy ?? null })
  return [...byId.values()]
    // A reply shown optimistically is dropped once Shopee returns the real one
    .filter((m) => !m.id.startsWith('local-') || !incoming.some((x) => x.fromShop && x.text === m.text))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export default function ChatPage() {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([])
  const [storeFilter, setStoreFilter] = useState('')
  const [listType, setListType] = useState<'all' | 'unread'>('all')

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listMore, setListMore] = useState(false)
  const [storeErrors, setStoreErrors] = useState<{ store: string; message: string }[]>([])
  const [notEnabled, setNotEnabled] = useState(false)
  const [listError, setListError] = useState('')

  const [active, setActive] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [olderOffset, setOlderOffset] = useState<string | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [olderLoading, setOlderLoading] = useState(false)
  const [threadError, setThreadError] = useState('')

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  const [orders, setOrders] = useState<BuyerOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<Conversation | null>(null)
  activeRef.current = active
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

  useEffect(() => {
    api.get('/chat/stores').then((r) => setStores(r.data?.data || [])).catch(() => {})
  }, [])

  // ── Conversation list ──────────────────────────────────────────────────────
  const loadList = useCallback(async (opts: { background?: boolean } = {}) => {
    if (!opts.background) setListLoading(true)
    try {
      const res = await api.get('/chat/conversations', {
        params: { storeId: storeFilter || undefined, type: listType },
      })
      const data = res.data?.data
      const fresh: Conversation[] = data?.conversations || []
      if (opts.background) {
        // A refresh only brings back the newest page; older pages the operator
        // already loaded stay, updated where the fresh page has them.
        setConversations((prev) => {
          const key = (c: Conversation) => `${c.storeId}:${c.id}`
          const freshKeys = new Set(fresh.map(key))
          return [...fresh, ...prev.filter((c) => !freshKeys.has(key(c)))]
            .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
        })
      } else {
        setConversations(fresh)
        setCursor(data?.nextCursor || null)
      }
      setStoreErrors(data?.errors || [])
      setNotEnabled(false)
      setListError('')
    } catch (err) {
      const e = readError(err)
      if (e.code === 'CHAT_NOT_ENABLED') setNotEnabled(true)
      else if (!opts.background) setListError(e.text)
    } finally {
      if (!opts.background) setListLoading(false)
    }
  }, [storeFilter, listType])

  useEffect(() => {
    loadList()
    const t = setInterval(() => loadList({ background: true }), LIST_POLL_MS)
    return () => clearInterval(t)
  }, [loadList])

  const loadMoreConversations = async () => {
    if (!cursor) return
    setListMore(true)
    try {
      const res = await api.get('/chat/conversations', {
        params: { storeId: storeFilter || undefined, type: listType, cursor },
      })
      const data = res.data?.data
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => `${c.storeId}:${c.id}`))
        return [...prev, ...(data?.conversations || []).filter((c: Conversation) => !seen.has(`${c.storeId}:${c.id}`))]
          .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      })
      setCursor(data?.nextCursor || null)
    } catch (err) {
      setListError(readError(err).text)
    } finally {
      setListMore(false)
    }
  }

  // ── One conversation ───────────────────────────────────────────────────────
  const markRead = useCallback(async (conv: Conversation, lastMessageId: string | null) => {
    if (!lastMessageId) return
    try {
      await api.post(`/chat/conversations/${conv.id}/read`, { storeId: conv.storeId, lastMessageId })
      setConversations((prev) => prev.map((c) => (c.id === conv.id && c.storeId === conv.storeId ? { ...c, unread: 0 } : c)))
      window.dispatchEvent(new Event('chat-read'))
    } catch {
      // Not worth interrupting the operator over; Shopee still shows it unread
    }
  }, [])

  const fetchThread = useCallback(async (conv: Conversation, opts: { background?: boolean } = {}) => {
    if (!opts.background) {
      setThreadLoading(true)
      setThreadError('')
    }
    try {
      const res = await api.get(`/chat/conversations/${conv.id}/messages`, { params: { storeId: conv.storeId } })
      if (activeRef.current?.id !== conv.id) return
      const data = res.data?.data
      const incoming: Message[] = data?.messages || []
      const prev = opts.background ? messagesRef.current : []
      const merged = mergeMessages(prev, incoming)
      setMessages(merged)
      // Opening a conversation reads it, and so does a buyer message that
      // arrives while it is open
      const newestBuyer = [...merged].reverse().find((m) => !m.fromShop)
      const prevNewestBuyer = [...prev].reverse().find((m) => !m.fromShop)
      if (newestBuyer && (!opts.background || newestBuyer.id !== prevNewestBuyer?.id)) {
        markRead(conv, merged[merged.length - 1]?.id || null)
      }
      if (!opts.background) setOlderOffset(data?.nextOffset || null)
    } catch (err) {
      if (!opts.background) setThreadError(readError(err).text)
    } finally {
      if (!opts.background) setThreadLoading(false)
    }
  }, [markRead])

  const openConversation = (conv: Conversation) => {
    setActive(conv)
    setMessages([])
    setOlderOffset(null)
    setDraft('')
    setSendError('')
    setOrders([])
    fetchThread(conv)
  }

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => fetchThread(active, { background: true }), THREAD_POLL_MS)
    return () => clearInterval(t)
  }, [active, fetchThread])

  // Keep the newest message in view when one arrives
  const lastId = messages[messages.length - 1]?.id
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lastId])

  const loadOlder = async () => {
    if (!active || !olderOffset) return
    setOlderLoading(true)
    try {
      const res = await api.get(`/chat/conversations/${active.id}/messages`, {
        params: { storeId: active.storeId, offset: olderOffset },
      })
      const data = res.data?.data
      setMessages((prev) => mergeMessages(prev, data?.messages || []))
      setOlderOffset(data?.nextOffset || null)
    } catch (err) {
      setThreadError(readError(err).text)
    } finally {
      setOlderLoading(false)
    }
  }

  // ── Buyer's orders beside the chat ─────────────────────────────────────────
  const mentionedOrders = useMemo(
    () => [...new Set(messages.map((m) => m.orderSn).filter(Boolean))] as string[],
    [messages],
  )
  const mentionedKey = mentionedOrders.join(',')

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setOrdersLoading(true)
    api.get('/chat/buyer-orders', {
      params: { storeId: active.storeId, buyerId: active.buyerId, orderSns: mentionedKey || undefined },
    })
      .then((r) => { if (!cancelled) setOrders(r.data?.data?.orders || []) })
      .catch(() => { if (!cancelled) setOrders([]) })
      .finally(() => { if (!cancelled) setOrdersLoading(false) })
    return () => { cancelled = true }
  }, [active, mentionedKey])

  // ── Sending ────────────────────────────────────────────────────────────────
  const afterSend = (msg: Message) => {
    setMessages((prev) => mergeMessages(prev, [msg]))
    if (active) {
      setConversations((prev) => prev.map((c) => (c.id === active.id && c.storeId === active.storeId
        ? { ...c, lastMessage: msg.preview, lastAt: msg.createdAt, awaitingReply: false }
        : c)))
    }
  }

  const sendText = async () => {
    const text = draft.trim()
    if (!active || !text || sending) return
    if ([...text].length > MAX_TEXT) {
      setSendError(`Pesan terlalu panjang — maksimal ${MAX_TEXT} karakter.`)
      return
    }
    setSending(true)
    setSendError('')
    try {
      const res = await api.post(`/chat/conversations/${active.id}/messages`, {
        storeId: active.storeId, toId: active.buyerId, text,
      })
      afterSend(res.data?.data?.message)
      setDraft('')
    } catch (err) {
      // The draft stays in the box, so nothing typed is lost to a refusal
      setSendError(readError(err).text)
    } finally {
      setSending(false)
    }
  }

  const sendImage = async (file: File) => {
    if (!active || sending) return
    if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
      setSendError('Gambar harus JPG, PNG, atau GIF.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setSendError('Gambar maksimal 10 MB.')
      return
    }
    setSending(true)
    setSendError('')
    try {
      const form = new FormData()
      form.append('image', file)
      form.append('storeId', active.storeId)
      form.append('toId', active.buyerId)
      const res = await api.post(`/chat/conversations/${active.id}/images`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120_000,
      })
      afterSend(res.data?.data?.message)
    } catch (err) {
      setSendError(readError(err).text)
    } finally {
      setSending(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const textLength = [...draft].length

  // ── Render ─────────────────────────────────────────────────────────────────
  if (notEnabled) {
    return (
      <div className="card p-8 max-w-xl mx-auto mt-8 text-center space-y-3">
        <MessageCircle className="w-10 h-10 mx-auto text-gray-500 dark:text-slate-400" />
        <h1 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Akses Chat belum dibuka Shopee</h1>
        <p className="text-sm text-gray-600 dark:text-slate-300">
          Shopee belum memberi izin Chat API untuk aplikasi ini, jadi pesan pembeli belum bisa dibaca dari
          OrderPro. Setelah izin disetujui, halaman ini langsung berfungsi — tidak perlu pengaturan lain.
        </p>
        <button onClick={() => loadList()} className="btn-secondary mx-auto">
          <RefreshCw className="w-4 h-4" /> Cek lagi
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">Chat</h1>
        <p className="text-xs text-gray-500 dark:text-slate-400 hidden sm:block">
          Hanya untuk membalas pembeli — pesan otomatis dan broadcast dilarang Shopee.
        </p>
      </div>

      {storeErrors.length > 0 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="break-words [overflow-wrap:anywhere]">
            Chat dari sebagian toko tidak termuat: {storeErrors.map((e) => `${e.store} (${e.message})`).join('; ')}
          </span>
        </div>
      )}

      <div className="card overflow-hidden flex h-[calc(100vh-11rem)] min-h-[480px]">
        {/* ── List ── */}
        <aside className={`${active ? 'hidden md:flex' : 'flex'} w-full md:w-80 shrink-0 flex-col border-r border-gray-200 dark:border-slate-700`}>
          <div className="p-3 space-y-2 border-b border-gray-200 dark:border-slate-700">
            <select
              value={storeFilter}
              onChange={(e) => setStoreFilter(e.target.value)}
              className="input w-full text-sm"
              aria-label="Filter toko"
            >
              <option value="">Semua Toko</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <div className="flex gap-1 text-sm">
              {(['all', 'unread'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setListType(t)}
                  className={`flex-1 rounded-md px-2 py-1.5 font-medium ${
                    listType === t
                      ? 'bg-primary-50 dark:bg-primary-950/50 text-primary-700 dark:text-primary-300'
                      : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60'
                  }`}
                >
                  {t === 'all' ? 'Semua' : 'Belum dibaca'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listLoading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary-600" /></div>
            ) : listError ? (
              <div className="p-4 text-sm text-red-700 dark:text-red-300">{listError}</div>
            ) : conversations.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500 dark:text-slate-400">
                {listType === 'unread' ? 'Semua chat sudah dibaca.' : 'Belum ada percakapan.'}
              </div>
            ) : (
              <>
                {conversations.map((c) => {
                  const selected = active?.id === c.id && active?.storeId === c.storeId
                  return (
                    <button
                      key={`${c.storeId}:${c.id}`}
                      onClick={() => openConversation(c)}
                      className={`w-full text-left px-3 py-2.5 flex gap-3 border-b border-gray-100 dark:border-slate-700/60 ${
                        selected ? 'bg-primary-50 dark:bg-primary-950/40' : 'hover:bg-gray-50 dark:hover:bg-slate-700/40'
                      }`}
                    >
                      <Avatar name={c.buyerName} url={c.avatar} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`truncate text-sm ${c.unread > 0 ? 'font-semibold text-gray-900 dark:text-slate-100' : 'text-gray-800 dark:text-slate-200'}`}>
                            {c.buyerName}
                          </span>
                          <span className="shrink-0 text-[11px] text-gray-500 dark:text-slate-400">{shortTime(c.lastAt)}</span>
                        </div>
                        <div className="text-[11px] text-gray-500 dark:text-slate-400 truncate">{c.storeName}</div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <span className={`truncate text-xs ${c.unread > 0 ? 'text-gray-900 dark:text-slate-100' : 'text-gray-600 dark:text-slate-300'}`}>
                            {c.lastMessage}
                          </span>
                          {c.unread > 0 ? (
                            <span className="shrink-0 rounded-full bg-shopee text-white text-[10px] font-semibold px-1.5 min-w-[18px] text-center">
                              {c.unread}
                            </span>
                          ) : c.awaitingReply ? (
                            <span className="shrink-0 text-[10px] font-medium text-amber-700 dark:text-amber-300">Belum dibalas</span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  )
                })}
                {cursor && (
                  <button
                    onClick={loadMoreConversations}
                    disabled={listMore}
                    className="w-full py-3 text-sm text-primary-700 dark:text-primary-300 hover:bg-gray-50 dark:hover:bg-slate-700/40"
                  >
                    {listMore ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Muat percakapan lama'}
                  </button>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Thread ── */}
        <section className={`${active ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
          {!active ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 dark:text-slate-400 gap-2 p-6 text-center">
              <MessageCircle className="w-10 h-10" />
              <p className="text-sm">Pilih percakapan untuk mulai membalas.</p>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-slate-700">
                <button onClick={() => setActive(null)} className="md:hidden btn-ghost p-1" aria-label="Kembali">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <Avatar name={active.buyerName} url={active.avatar} />
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 dark:text-slate-100 truncate">{active.buyerName}</div>
                  <div className="text-xs text-gray-500 dark:text-slate-400 truncate">{active.storeName}</div>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50 dark:bg-slate-900/40">
                {olderOffset && !threadLoading && (
                  <div className="text-center">
                    <button onClick={loadOlder} disabled={olderLoading} className="text-xs text-primary-700 dark:text-primary-300 hover:underline">
                      {olderLoading ? 'Memuat…' : 'Muat pesan sebelumnya'}
                    </button>
                  </div>
                )}
                {threadLoading ? (
                  <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary-600" /></div>
                ) : threadError ? (
                  <div className="text-sm text-red-700 dark:text-red-300">{threadError}</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-sm text-gray-500 dark:text-slate-400 py-10">Belum ada pesan.</div>
                ) : (
                  messages.map((m) => <Bubble key={m.id} m={m} />)
                )}
                <div ref={bottomRef} />
              </div>

              <footer className="border-t border-gray-200 dark:border-slate-700 p-3 space-y-2">
                {sendError && (
                  <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 break-words [overflow-wrap:anywhere]">
                    {sendError}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f) }}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={sending}
                    className="btn-ghost p-2 shrink-0"
                    title="Kirim gambar (JPG/PNG/GIF, maks 10 MB)"
                  >
                    <ImagePlus className="w-5 h-5" />
                  </button>
                  <div className="flex-1 min-w-0">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          sendText()
                        }
                      }}
                      rows={2}
                      placeholder="Tulis balasan… (Enter kirim, Shift+Enter baris baru)"
                      className="input w-full resize-none text-sm"
                      disabled={sending}
                    />
                    <div className={`text-right text-[11px] ${textLength > MAX_TEXT ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-gray-500 dark:text-slate-400'}`}>
                      {textLength}/{MAX_TEXT}
                    </div>
                  </div>
                  <button
                    onClick={sendText}
                    disabled={sending || !draft.trim() || textLength > MAX_TEXT}
                    className="btn bg-shopee text-white hover:bg-orange-600 shrink-0 mb-5"
                  >
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Kirim
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>

        {/* ── Buyer's orders ── */}
        {active && (
          <aside className="hidden xl:flex w-72 shrink-0 flex-col border-l border-gray-200 dark:border-slate-700">
            <div className="px-3 py-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <Package className="w-4 h-4" /> Pesanan pembeli
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {ordersLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-primary-600" /></div>
              ) : orders.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Tidak ada pesanan yang cocok di toko ini. Pesanan lama baru tertaut setelah sinkron berikutnya.
                </p>
              ) : (
                orders.map((o) => <OrderCard key={o.id} o={o} />)
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" onError={() => setBroken(true)} className="w-9 h-9 rounded-full object-cover shrink-0" />
  }
  return (
    <div className="w-9 h-9 rounded-full bg-primary-100 dark:bg-primary-950 flex items-center justify-center shrink-0">
      <span className="text-sm font-semibold text-primary-700 dark:text-primary-300">{name.charAt(0).toUpperCase() || '?'}</span>
    </div>
  )
}

function Bubble({ m }: { m: Message }) {
  const mine = m.fromShop
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
        mine
          ? 'bg-primary-600 text-white'
          : 'bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 border border-gray-200 dark:border-slate-700'
      }`}>
        {m.imageUrl ? (
          <a href={m.imageUrl} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.imageUrl} alt="Gambar" className="max-h-60 rounded" />
          </a>
        ) : m.text ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.text}</p>
        ) : (
          <p className="italic opacity-90">{m.preview}</p>
        )}
        {m.orderSn && !m.text && (
          <p className="mt-1 font-mono text-xs opacity-90">{m.orderSn}</p>
        )}
        <div className={`mt-1 text-[10px] ${mine ? 'text-white/85' : 'text-gray-500 dark:text-slate-400'}`}>
          {fullTime(m.createdAt)}
          {mine && m.sentBy ? ` · ${m.sentBy}` : ''}
          {mine && !m.sentBy && m.source && m.source !== 'openapi' ? ' · dari Seller Centre' : ''}
        </div>
      </div>
    </div>
  )
}

function OrderCard({ o }: { o: BuyerOrder }) {
  return (
    <Link
      href={`/orders?search=${encodeURIComponent(o.orderId)}`}
      className="block rounded-lg border border-gray-200 dark:border-slate-700 p-2.5 hover:bg-gray-50 dark:hover:bg-slate-700/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium text-gray-900 dark:text-slate-100 truncate">{o.orderId}</span>
        <span className="shrink-0 rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700 dark:text-slate-200">
          {STATUS_LABEL[o.status] || o.status}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">{fullTime(o.orderDate)}</div>
      <ul className="mt-1.5 space-y-0.5">
        {o.items.slice(0, 3).map((i, idx) => (
          <li key={idx} className="text-xs text-gray-700 dark:text-slate-300 line-clamp-2">
            {i.qty}× {i.name}{i.variant ? ` (${i.variant})` : ''}
          </li>
        ))}
        {o.items.length > 3 && <li className="text-[11px] text-gray-500 dark:text-slate-400">+{o.items.length - 3} produk lain</li>}
      </ul>
      {(o.courier || o.trackingNumber) && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-600 dark:text-slate-300">
          <Truck className="w-3 h-3 shrink-0" />
          <span className="truncate">{o.courier}{o.trackingNumber ? ` · ${o.trackingNumber}` : ''}</span>
        </div>
      )}
      {o.buyerNote && (
        <p className="mt-1.5 text-[11px] text-amber-800 dark:text-amber-200">Catatan: {o.buyerNote}</p>
      )}
    </Link>
  )
}
