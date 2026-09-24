'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import api from '@/lib/api'
import {
  AttributeDef, AttributeValue, ChannelDef, DraftModel, DraftPayload, DraftStatus, FormOptions, ImageRef,
  STATUS_CLASS, STATUS_LABEL, Tier, ValidationError,
  apiError, charCount, imageSrc, modelLabel, newOptionKey, regenerateModels, sectionOf, toPlainDescription,
} from '@/lib/productDraft'
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, ImagePlus, Loader2, Plus, Star, Trash2, X,
} from 'lucide-react'

interface DraftMeta {
  id: string
  status: DraftStatus
  editable: boolean
  targetStore: { id: string; name: string }
  sourceStore: { id: string; name: string }
  publishedItemId: string | null
  itemAlreadyCreated: boolean
  lastError: string | null
  source: { name: string; logistics: { channelId: number; name: string; enabled: boolean }[] }
}

const num = (v: string): number | null => {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export default function EditDraftPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
      </div>
    }>
      <EditDraft />
    </Suspense>
  )
}

function EditDraft() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const id = searchParams.get('id') || ''

  const [meta, setMeta] = useState<DraftMeta | null>(null)
  const [payload, setPayload] = useState<DraftPayload | null>(null)
  const [options, setOptions] = useState<FormOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [errors, setErrors] = useState<ValidationError[]>([])
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!id) { setLoadError('ID draf tidak ada di alamat halaman'); return }
    setLoadError(null)
    try {
      const [draftRes, optRes] = await Promise.all([
        api.get<any>(`/products/drafts/${id}`),
        api.get<any>(`/products/drafts/${id}/form-options`),
      ])
      const d = draftRes.data
      const opts: FormOptions = optRes.data
      const p: DraftPayload = clone(d.payload)

      // Jasa Kirim lists what the destination shop has switched on, ticked where
      // the source item had it. A channel the shop does not offer cannot be sent.
      if (opts.channels) {
        const had = new Map(p.logistics.map((l) => [l.channelId, l]))
        p.logistics = opts.channels.filter((c) => c.enabled).map((c) => ({
          channelId: c.channelId, name: c.name, enabled: had.get(c.channelId)?.enabled ?? false,
        }))
      }

      setMeta({
        id: d.id, status: d.status, editable: d.editable, targetStore: d.targetStore, sourceStore: d.sourceStore,
        publishedItemId: d.publishedItemId, itemAlreadyCreated: d.itemAlreadyCreated, lastError: d.lastError, source: d.source,
      })
      setPayload(p)
      setOptions(opts)
      setErrors(opts.errors || [])
      setDirty(false)
    } catch (err) {
      setLoadError(apiError(err, 'Draf tidak bisa dimuat'))
    }
  }, [id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  /** Every edit goes through here: a clone, changed, marked unsaved. */
  const mutate = useCallback((fn: (p: DraftPayload) => void) => {
    setPayload((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
    setDirty(true)
  }, [])

  const uploadImage = async (file: File, scene: 'normal' | 'desc', label: string): Promise<ImageRef | null> => {
    setUploading(label)
    setMessage(null)
    try {
      const fd = new FormData()
      fd.append('image', file)
      fd.append('scene', scene)
      const res = await api.post<any>(`/products/drafts/${id}/images`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120_000,
      })
      return { imageId: res.data.imageId, url: res.data.url }
    } catch (err) {
      setMessage({ type: 'error', text: `${label}: ${apiError(err, 'gagal diunggah')}` })
      return null
    } finally {
      setUploading(null)
    }
  }

  const save = async (): Promise<boolean> => {
    if (!payload) return false
    setSaving(true)
    setMessage(null)
    try {
      await api.patch(`/products/drafts/${id}`, { payload })
      setDirty(false)
      // Re-check against the destination shop, so the list of problems follows
      // what was just saved rather than what the form opened with.
      const opt = await api.get<any>(`/products/drafts/${id}/form-options`)
      setErrors(opt.data?.errors ?? [])
      return true
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Gagal menyimpan draf') })
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (await save()) setMessage({ type: 'success', text: 'Draf tersimpan.' })
  }

  const handlePublish = async () => {
    setPublishing(true)
    try {
      if (!(await save())) return
      await api.post(`/products/drafts/${id}/publish`)
      router.push('/products?tab=drafts')
    } catch (err: any) {
      const list: ValidationError[] | undefined = err?.response?.data?.errors
      if (list?.length) {
        setErrors(list)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } else {
        setMessage({ type: 'error', text: apiError(err, 'Gagal memulai Publish') })
      }
    } finally {
      setPublishing(false)
    }
  }

  const handleCancel = () => {
    if (dirty && !window.confirm('Buang perubahan yang belum disimpan?')) return
    setDirty(false)
    router.push('/products?tab=drafts')
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <Link href="/products?tab=drafts" className="text-sm text-primary-600 dark:text-primary-400 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Draf
        </Link>
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {loadError}
        </div>
      </div>
    )
  }

  if (!payload || !options || !meta) {
    return (
      <div className="flex items-center justify-center py-20 gap-2 text-sm text-gray-500 dark:text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" /> Memuat draf dan data toko tujuan dari Shopee…
      </div>
    )
  }

  const L = options.limits
  const busy = saving || publishing || Boolean(uploading)

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <button onClick={handleCancel} className="text-sm text-primary-600 dark:text-primary-400 flex items-center gap-1 mb-1">
            <ArrowLeft className="w-4 h-4" /> Kembali ke Draf
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{meta.editable ? 'Edit Produk' : 'Lihat Produk'}</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Salinan dari {meta.sourceStore.name} untuk <span className="font-medium">{meta.targetStore.name}</span>
          </p>
        </div>
        <span className={`self-start px-2 py-1 rounded text-xs font-medium ${STATUS_CLASS[meta.status]}`}>{STATUS_LABEL[meta.status]}</span>
      </div>

      {meta.itemAlreadyCreated && (
        <Notice tone="amber">
          Percobaan Publish sebelumnya sudah membuat produk ini di Shopee (item {meta.publishedItemId}, belum tayang).
          Publish berikutnya akan melanjutkan dan memperbarui produk itu, bukan membuat produk baru.
        </Notice>
      )}
      {meta.status === 'FAILED' && meta.lastError && <Notice tone="red">Publish terakhir gagal: {meta.lastError}</Notice>}
      {options.warnings.map((w, i) => <Notice key={i} tone="amber">{w}</Notice>)}
      {message && <Notice tone={message.type === 'success' ? 'blue' : 'red'}>{message.text}</Notice>}

      {errors.length > 0 && meta.editable && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <p className="font-semibold mb-1">{errors.length} hal perlu diperbaiki sebelum Publish</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>
                <button
                  className="text-left underline decoration-dotted"
                  onClick={() => document.getElementById(sectionOf(e.field))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {e.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset disabled={!meta.editable || busy} className="space-y-4 min-w-0">
        <BasicSection meta={meta} payload={payload} limits={L} plainOnly={Boolean(options.plainDescriptionOnly)} mutate={mutate} uploadImage={uploadImage} />
        <AttributeSection draftId={id} payload={payload} options={options} mutate={mutate} />
        <MediaSection payload={payload} limits={L} mutate={mutate} uploadImage={uploadImage} />
        <SalesSection payload={payload} limits={L} mutate={mutate} />
        <ShippingSection meta={meta} payload={payload} channels={options.channels} mutate={mutate} />
        <OtherSection payload={payload} limits={L} mutate={mutate} />
      </fieldset>

      {meta.editable && (
        <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-40 border-t border-gray-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 py-3">
          <div className="max-w-7xl flex flex-wrap items-center justify-end gap-2">
            {uploading && (
              <span className="mr-auto text-xs text-gray-600 dark:text-slate-300 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Mengunggah {uploading}…
              </span>
            )}
            {!uploading && dirty && <span className="mr-auto text-xs text-amber-700 dark:text-amber-400">Ada perubahan belum disimpan</span>}
            <button onClick={handleCancel} disabled={busy} className="btn-secondary">Batal</button>
            <button onClick={handleSave} disabled={busy} className="btn-secondary flex items-center gap-2">
              {saving && !publishing && <Loader2 className="w-4 h-4 animate-spin" />} Simpan Draf
            </button>
            <button onClick={handlePublish} disabled={busy} className="btn-primary flex items-center gap-2">
              {publishing && <Loader2 className="w-4 h-4 animate-spin" />} Publish Produk
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Building blocks ───────────────────────────────────────────────────────────

type Mutate = (fn: (p: DraftPayload) => void) => void
type Upload = (file: File, scene: 'normal' | 'desc', label: string) => Promise<ImageRef | null>

function Notice({ tone, children }: { tone: 'red' | 'amber' | 'blue'; children: React.ReactNode }) {
  const cls = {
    red: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200',
    amber: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200',
    blue: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200',
  }[tone]
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm flex items-start gap-2 ${cls}`}>
      {tone !== 'blue' && <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
      <div className="break-words [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card p-4 sm:p-5 space-y-4 scroll-mt-20">
      <h2 className="text-base font-semibold text-gray-900 dark:text-slate-100">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-1 sm:gap-4">
      <label className="text-sm text-gray-600 dark:text-slate-300 sm:pt-2">
        {required && <span className="text-red-600 mr-0.5">*</span>}{label}
      </label>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className="text-xs text-gray-500 dark:text-slate-400">{hint}</p>}
      </div>
    </div>
  )
}

function Counter({ value, max, min }: { value: number; max: number; min?: number }) {
  const bad = value > max || (min !== undefined && value > 0 && value < min)
  return <span className={`text-xs tabular-nums ${bad ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-slate-400'}`}>{value}/{max}</span>
}

/** A button that opens the file chooser. Disabled with the surrounding fieldset. */
function FilePick({ onPick, children, className }: { onPick: (f: File) => void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" onClick={() => ref.current?.click()} className={className}>{children}</button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onPick(f)
        }}
      />
    </>
  )
}

function Thumb({ img, className = 'w-20 h-20' }: { img: ImageRef | null | undefined; className?: string }) {
  const src = imageSrc(img)
  return src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={src} alt="" className={`${className} rounded object-cover border border-gray-200 dark:border-slate-700`} />
    : <div className={`${className} rounded border border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center text-[10px] text-gray-500 dark:text-slate-400 text-center p-1`}>dari produk asal</div>
}

// ── Informasi Dasar ───────────────────────────────────────────────────────────

function BasicSection({ meta, payload, limits: L, plainOnly, mutate, uploadImage }: {
  meta: DraftMeta; payload: DraftPayload; limits: FormOptions['limits']; plainOnly: boolean; mutate: Mutate; uploadImage: Upload
}) {
  const sameName = payload.name.trim() === meta.source.name.trim()
  const blocks = payload.descriptionBlocks || []
  const textLen = blocks.filter((b) => b.type === 'text').reduce((n, b) => n + charCount((b as { text: string }).text), 0)
  const imageCount = blocks.filter((b) => b.type === 'image').length

  const moveBlock = (i: number, dir: -1 | 1) => mutate((p) => {
    const j = i + dir
    if (j < 0 || j >= p.descriptionBlocks.length) return
    ;[p.descriptionBlocks[i], p.descriptionBlocks[j]] = [p.descriptionBlocks[j], p.descriptionBlocks[i]]
  })

  return (
    <Section id="section-dasar" title="Informasi Dasar">
      <Field label="Toko">
        <p className="input bg-gray-50 dark:bg-slate-800 cursor-default">{meta.targetStore.name}</p>
      </Field>

      <Field
        label="Nama Produk"
        required
        hint={sameName
          ? <span className="text-red-600 dark:text-red-400">Masih sama persis dengan produk asal — ubah sedikit, Shopee tidak menerima nama yang sama.</span>
          : undefined}
      >
        <div className="relative">
          <input
            value={payload.name}
            onChange={(e) => mutate((p) => { p.name = e.target.value })}
            className={`input pr-20 ${sameName ? 'border-red-400 dark:border-red-700' : ''}`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2"><Counter value={charCount(payload.name)} max={L.nameMax} min={L.nameMin} /></span>
        </div>
      </Field>

      <Field label="Deskripsi" required>
        {payload.descriptionType === 'normal' ? (
          <>
            <textarea
              value={payload.description}
              onChange={(e) => mutate((p) => { p.description = e.target.value })}
              rows={10}
              className="input"
            />
            <div className="text-right"><Counter value={charCount(payload.description)} max={L.descriptionMax} min={L.descriptionMin} /></div>
          </>
        ) : (
          <div className="space-y-2">
            {plainOnly && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {meta.targetStore.name} belum diizinkan Shopee memakai deskripsi bergambar. Ubah jadi teks biasa sebelum Publish.
              </p>
            )}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Deskripsi bergambar: teks dan gambar tampil berurutan seperti di Shopee.
                Teks {textLen}/{L.extendedTextMax} karakter · gambar {imageCount}/{L.extendedImageMax}.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (imageCount > 0 && !window.confirm(`${imageCount} gambar deskripsi akan dibuang, teksnya digabung. Lanjut?`)) return
                  mutate(toPlainDescription)
                }}
                className={`${plainOnly ? 'btn-primary' : 'btn-secondary'} text-xs px-2 py-1 shrink-0`}
              >
                Ubah jadi teks biasa
              </button>
            </div>
            {blocks.map((b, i) => (
              <div key={i} className="flex gap-2 items-start rounded border border-gray-200 dark:border-slate-700 p-2">
                <div className="flex-1 min-w-0">
                  {b.type === 'text' ? (
                    <textarea
                      value={b.text}
                      onChange={(e) => mutate((p) => { (p.descriptionBlocks[i] as { text: string }).text = e.target.value })}
                      rows={Math.min(12, Math.max(3, b.text.split('\n').length + 1))}
                      className="input"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <Thumb img={b} className="w-24 h-24" />
                      <FilePick
                        className="btn-secondary text-xs px-2 py-1"
                        onPick={async (f) => {
                          const img = await uploadImage(f, 'desc', 'gambar deskripsi')
                          if (img) mutate((p) => { p.descriptionBlocks[i] = { type: 'image', ...img } })
                        }}
                      >Ganti</FilePick>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <button type="button" onClick={() => moveBlock(i, -1)} className="p-1 text-gray-500 hover:text-gray-800 dark:hover:text-slate-200" aria-label="Naikkan"><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" onClick={() => moveBlock(i, 1)} className="p-1 text-gray-500 hover:text-gray-800 dark:hover:text-slate-200" aria-label="Turunkan"><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => mutate((p) => { p.descriptionBlocks.splice(i, 1) })} className="p-1 text-red-500" aria-label="Hapus blok"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <button type="button" onClick={() => mutate((p) => { p.descriptionBlocks.push({ type: 'text', text: '' }) })} className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
                <Plus className="w-3 h-3" /> Teks
              </button>
              <FilePick
                className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
                onPick={async (f) => {
                  const img = await uploadImage(f, 'desc', 'gambar deskripsi')
                  if (img) mutate((p) => { p.descriptionBlocks.push({ type: 'image', ...img }) })
                }}
              >
                <ImagePlus className="w-3 h-3" /> Gambar
              </FilePick>
            </div>
          </div>
        )}
      </Field>

      <Field label="Kategori" hint="Sama dengan produk asal. Ubah kategori belum tersedia.">
        <p className="text-sm text-gray-900 dark:text-slate-100 sm:pt-2">ID kategori Shopee {payload.categoryId ?? '—'}</p>
      </Field>
    </Section>
  )
}

// ── Atribut Produk ────────────────────────────────────────────────────────────

function AttributeSection({ draftId, payload, options, mutate }: {
  draftId: string; payload: DraftPayload; options: FormOptions; mutate: Mutate
}) {
  const [showOthers, setShowOthers] = useState(false)
  const [brandQuery, setBrandQuery] = useState('')
  const [brandResults, setBrandResults] = useState<{ id: number; name: string }[] | null>(null)
  const [brandLoading, setBrandLoading] = useState(false)

  useEffect(() => {
    if (!brandQuery.trim()) { setBrandResults(null); return }
    const t = setTimeout(async () => {
      setBrandLoading(true)
      try {
        const res = await api.get<any>(`/products/drafts/${draftId}/brands`, { params: { q: brandQuery } })
        setBrandResults(res.data?.brands ?? [])
      } catch {
        setBrandResults([])
      } finally {
        setBrandLoading(false)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [brandQuery, draftId])

  const defs = options.attributes
  const known = new Set(defs.map((d) => d.attributeId))
  const mandatory = defs.filter((d) => d.mandatory)
  const others = defs.filter((d) => !d.mandatory)
  // Attributes the copy carried that the destination's tree did not list —
  // shown so nothing is sent unseen.
  const orphans = payload.attributes.filter((a) => !known.has(a.attributeId))

  const setValues = (def: AttributeDef, values: AttributeValue[]) => mutate((p) => {
    const i = p.attributes.findIndex((a) => a.attributeId === def.attributeId)
    if (values.length === 0) {
      if (i >= 0) p.attributes.splice(i, 1)
    } else if (i >= 0) {
      p.attributes[i].values = values
    } else {
      p.attributes.push({ attributeId: def.attributeId, name: def.name, values })
    }
  })

  const valuesOf = (def: AttributeDef) => payload.attributes.find((a) => a.attributeId === def.attributeId)?.values ?? []

  return (
    <Section id="section-atribut" title="Atribut Produk">
      <Field label="Merek" required={options.brandMandatory}>
        <div className="space-y-1">
          <p className="text-sm text-gray-900 dark:text-slate-100">
            {payload.brand.id > 0 ? payload.brand.name : 'Tanpa merek (NoBrand)'}
          </p>
          <div className="relative">
            <input
              value={brandQuery}
              onChange={(e) => setBrandQuery(e.target.value)}
              placeholder="Cari merek lain…"
              className="input"
            />
            {brandLoading && <Loader2 className="w-4 h-4 animate-spin absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />}
          </div>
          {brandResults && (
            <div className="rounded border border-gray-200 dark:border-slate-700 max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
              {!options.brandMandatory && (
                <button type="button" onClick={() => { mutate((p) => { p.brand = { id: 0, name: 'NoBrand' } }); setBrandQuery('') }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-slate-800">
                  Tanpa merek (NoBrand)
                </button>
              )}
              {brandResults.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-500 dark:text-slate-400">Merek tidak ditemukan untuk kategori ini</p>
              ) : brandResults.map((b) => (
                <button key={b.id} type="button" onClick={() => { mutate((p) => { p.brand = { id: b.id, name: b.name } }); setBrandQuery('') }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-slate-800">
                  {b.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>

      {defs.length === 0 && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          Daftar atribut kategori tidak terbaca dari Shopee. Atribut dari produk asal tetap dikirim apa adanya.
        </p>
      )}

      {mandatory.map((def) => (
        <AttributeInput key={def.attributeId} def={def} values={valuesOf(def)} onChange={(v) => setValues(def, v)} />
      ))}

      {others.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOthers((s) => !s)}
          className="w-full rounded bg-gray-50 dark:bg-slate-800/60 py-2 text-sm text-gray-600 dark:text-slate-300 flex items-center justify-center gap-1"
        >
          {showOthers ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          Atribut Lainnya ({others.length})
        </button>
      )}
      {showOthers && others.map((def) => (
        <AttributeInput key={def.attributeId} def={def} values={valuesOf(def)} onChange={(v) => setValues(def, v)} />
      ))}

      {orphans.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500 dark:text-slate-400">Atribut lain dari produk asal:</p>
          {orphans.map((a) => (
            <div key={a.attributeId} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-gray-700 dark:text-slate-300">{a.name || `Atribut ${a.attributeId}`}: {a.values.map((v) => v.name).join(', ')}</span>
              <button type="button" onClick={() => mutate((p) => { p.attributes = p.attributes.filter((x) => x.attributeId !== a.attributeId) })} className="text-red-500 p-1" aria-label="Hapus atribut">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function AttributeInput({ def, values, onChange }: { def: AttributeDef; values: AttributeValue[]; onChange: (v: AttributeValue[]) => void }) {
  const listId = `attr-${def.attributeId}`
  const current = values[0]
  const byName = (name: string): AttributeValue => {
    const hit = def.values.find((v) => v.name.toLowerCase() === name.trim().toLowerCase())
    return hit ? { ...hit } : { valueId: 0, name, unit: current?.unit || def.units[0] || '' }
  }

  let control: React.ReactNode
  if (def.inputType === 'select') {
    const inList = !current || def.values.some((v) => v.valueId === current.valueId)
    control = (
      <select
        value={current ? String(current.valueId || `name:${current.name}`) : ''}
        onChange={(e) => {
          const v = def.values.find((x) => String(x.valueId) === e.target.value)
          onChange(v ? [{ ...v }] : [])
        }}
        className="input"
      >
        <option value="">— pilih —</option>
        {!inList && current && <option value={String(current.valueId || `name:${current.name}`)}>{current.name}</option>}
        {def.values.map((v) => <option key={v.valueId} value={String(v.valueId)}>{v.name}</option>)}
      </select>
    )
  } else if (def.inputType === 'text' || def.inputType === 'combo') {
    control = (
      <div className="flex gap-2">
        <input
          value={current?.name ?? ''}
          list={def.inputType === 'combo' ? listId : undefined}
          onChange={(e) => onChange(e.target.value.trim() === '' ? [] : [byName(e.target.value)])}
          className="input"
        />
        {def.inputType === 'combo' && (
          <datalist id={listId}>{def.values.map((v) => <option key={v.valueId} value={v.name} />)}</datalist>
        )}
        {def.units.length > 0 && current && (
          <select value={current.unit} onChange={(e) => onChange([{ ...current, unit: e.target.value }])} className="input w-28">
            {def.units.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
      </div>
    )
  } else {
    const chosen = new Set(values.map((v) => v.valueId || `name:${v.name}`))
    const toggle = (v: AttributeValue) => {
      const k = v.valueId || `name:${v.name}`
      if (chosen.has(k)) onChange(values.filter((x) => (x.valueId || `name:${x.name}`) !== k))
      else if (!def.maxValues || values.length < def.maxValues) onChange([...values, { ...v }])
    }
    const custom = values.filter((v) => !v.valueId)
    control = (
      <div className="space-y-1">
        <div className="max-h-40 overflow-y-auto rounded border border-gray-200 dark:border-slate-700 p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
          {[...def.values, ...custom].map((v) => (
            <label key={v.valueId || `c-${v.name}`} className="flex items-center gap-2 text-sm text-gray-800 dark:text-slate-200">
              <input type="checkbox" checked={chosen.has(v.valueId || `name:${v.name}`)} onChange={() => toggle(v)} className="rounded border-gray-300 dark:border-slate-600" />
              {v.name}
            </label>
          ))}
        </div>
        {def.inputType === 'multicombo' && (
          <input
            placeholder="Tambah nilai lain, lalu Enter"
            className="input"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              const text = (e.target as HTMLInputElement).value.trim()
              if (!text) return
              toggle(byName(text))
              ;(e.target as HTMLInputElement).value = ''
            }}
          />
        )}
      </div>
    )
  }

  return (
    <Field label={def.name} required={def.mandatory} hint={def.maxValues && def.maxValues > 1 ? `Maksimal ${def.maxValues} nilai` : undefined}>
      {control}
    </Field>
  )
}

// ── Media ─────────────────────────────────────────────────────────────────────

function MediaSection({ payload, limits: L, mutate, uploadImage }: {
  payload: DraftPayload; limits: FormOptions['limits']; mutate: Mutate; uploadImage: Upload
}) {
  const dragFrom = useRef<number | null>(null)
  const images = payload.images
  const firstTier = payload.tiers[0]

  const move = (from: number, to: number) => mutate((p) => {
    const [img] = p.images.splice(from, 1)
    p.images.splice(to, 0, img)
  })

  return (
    <Section id="section-media" title="Media">
      <p className="text-xs rounded bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 px-3 py-2">
        Urutan foto produk bisa diubah dengan drag and drop. Foto dari produk asal diunggah ulang ke toko tujuan saat Publish.
      </p>

      <Field label="Foto Produk" required hint={`${images.length}/${L.imageMax} foto, minimal ${L.imageMin}`}>
        <div className="flex flex-wrap gap-3">
          {images.map((img, i) => (
            <div
              key={`${img.imageId || img.url || img.sourceImageId}-${i}`}
              draggable
              onDragStart={() => { dragFrom.current = i }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragFrom.current !== null && dragFrom.current !== i) move(dragFrom.current, i); dragFrom.current = null }}
              className="w-24 space-y-1 cursor-move"
            >
              <Thumb img={img} className="w-24 h-24" />
              <p className="text-[11px] text-center text-gray-600 dark:text-slate-300">{i === 0 ? '* Foto Utama' : `Foto ${i}`}</p>
              <div className="flex justify-center gap-1">
                {i > 0 && (
                  <button type="button" onClick={() => move(i, 0)} className="p-1 text-gray-500 hover:text-amber-500" title="Jadikan Foto Utama"><Star className="w-3.5 h-3.5" /></button>
                )}
                <FilePick
                  className="p-1 text-gray-500 hover:text-primary-600"
                  onPick={async (f) => {
                    const up = await uploadImage(f, 'normal', `Foto ${i + 1}`)
                    if (up) mutate((p) => { p.images[i] = up })
                  }}
                ><ImagePlus className="w-3.5 h-3.5" /></FilePick>
                <button type="button" onClick={() => mutate((p) => { p.images.splice(i, 1) })} className="p-1 text-gray-500 hover:text-red-600" title="Hapus"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
          {images.length < L.imageMax && (
            <FilePick
              className="w-24 h-24 rounded border-2 border-dashed border-gray-300 dark:border-slate-600 flex flex-col items-center justify-center text-xs text-gray-500 dark:text-slate-400 hover:border-primary-500"
              onPick={async (f) => {
                const up = await uploadImage(f, 'normal', 'foto produk')
                if (up) mutate((p) => { p.images.push(up) })
              }}
            >
              <ImagePlus className="w-5 h-5 mb-1" /> Tambah
            </FilePick>
          )}
        </div>
      </Field>

      {firstTier && (
        <Field label="Foto Variasi" hint="Isi untuk semua pilihan, atau kosongkan semua.">
          <div className="flex flex-wrap gap-3">
            {firstTier.options.map((opt, o) => (
              <div key={opt.key} className="w-24 space-y-1">
                {opt.image ? <Thumb img={opt.image} className="w-24 h-24" /> : (
                  <FilePick
                    className="w-24 h-24 rounded border-2 border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center text-gray-500"
                    onPick={async (f) => {
                      const up = await uploadImage(f, 'normal', `foto variasi ${opt.name}`)
                      if (up) mutate((p) => { p.tiers[0].options[o].image = up })
                    }}
                  ><ImagePlus className="w-5 h-5" /></FilePick>
                )}
                <p className="text-[11px] text-center text-gray-600 dark:text-slate-300 truncate">{opt.name || '(tanpa nama)'}</p>
                {opt.image && (
                  <div className="flex justify-center gap-1">
                    <FilePick
                      className="p-1 text-gray-500 hover:text-primary-600"
                      onPick={async (f) => {
                        const up = await uploadImage(f, 'normal', `foto variasi ${opt.name}`)
                        if (up) mutate((p) => { p.tiers[0].options[o].image = up })
                      }}
                    ><ImagePlus className="w-3.5 h-3.5" /></FilePick>
                    <button type="button" onClick={() => mutate((p) => { p.tiers[0].options[o].image = null })} className="p-1 text-gray-500 hover:text-red-600" title="Hapus"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label="Video Produk" hint="Video belum ikut disalin. Tambahkan lewat Seller Centre setelah produk tayang.">
        <p className="text-sm text-gray-500 dark:text-slate-400 sm:pt-2">—</p>
      </Field>

      <Field label="Bagan Ukuran" required={L.sizeChartMandatory}>
        {payload.sizeChart?.kind === 'template' ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Produk asal memakai template bagan ukuran milik toko asal, yang tidak berlaku di toko ini. Unggah gambar bagan ukuran.
            </p>
            <FilePick
              className="btn-secondary text-sm flex items-center gap-1"
              onPick={async (f) => {
                const up = await uploadImage(f, 'desc', 'bagan ukuran')
                if (up) mutate((p) => { p.sizeChart = { kind: 'image', ...up } })
              }}
            ><ImagePlus className="w-4 h-4" /> Unggah gambar</FilePick>
          </div>
        ) : payload.sizeChart ? (
          <div className="flex items-end gap-2">
            <Thumb img={payload.sizeChart} className="w-28 h-28" />
            <FilePick
              className="btn-secondary text-xs px-2 py-1"
              onPick={async (f) => {
                const up = await uploadImage(f, 'desc', 'bagan ukuran')
                if (up) mutate((p) => { p.sizeChart = { kind: 'image', ...up } })
              }}
            >Ganti</FilePick>
            <button type="button" onClick={() => mutate((p) => { p.sizeChart = null })} className="btn-secondary text-xs px-2 py-1 text-red-600">Hapus</button>
          </div>
        ) : (
          <FilePick
            className="w-28 h-28 rounded border-2 border-dashed border-gray-300 dark:border-slate-600 flex flex-col items-center justify-center text-xs text-gray-500 dark:text-slate-400 hover:border-primary-500"
            onPick={async (f) => {
              const up = await uploadImage(f, 'desc', 'bagan ukuran')
              if (up) mutate((p) => { p.sizeChart = { kind: 'image', ...up } })
            }}
          ><ImagePlus className="w-5 h-5 mb-1" /> JPG/PNG</FilePick>
        )}
      </Field>
    </Section>
  )
}

// ── Informasi Penjualan ───────────────────────────────────────────────────────

function SalesSection({ payload, limits: L, mutate }: { payload: DraftPayload; limits: FormOptions['limits']; mutate: Mutate }) {
  const [bulk, setBulk] = useState({ price: '', stock: '', sku: '' })
  const tiers = payload.tiers
  const fallback = () => ({ price: payload.price, stock: payload.stock, sku: payload.itemSku })

  const withTiers = (fn: (tiers: Tier[], p: DraftPayload) => void) => mutate((p) => {
    fn(p.tiers, p)
    p.models = regenerateModels(p.tiers, p.models, { price: p.price, stock: p.stock, sku: p.itemSku })
  })

  const addTier = () => mutate((p) => {
    const key = newOptionKey()
    if (p.tiers.length === 0) {
      p.tiers = [{ name: '', options: [{ key, name: '', sourceName: null, image: null }] }]
      p.models = regenerateModels(p.tiers, [], fallback())
    } else {
      // A second variation with one option leaves every existing variant as it
      // was — including its link to the source — just one level deeper.
      p.tiers.push({ name: '', options: [{ key, name: '', sourceName: null, image: null }] })
      p.models = p.models.map((m) => ({ ...m, optionKeys: [...m.optionKeys, key] }))
    }
  })

  const removeTier = (t: number) => mutate((p) => {
    if (p.tiers.length === 1) {
      const first = p.models[0]
      p.price = first?.price ?? p.price
      p.stock = p.models.reduce((n, m) => n + (m.stock ?? 0), 0)
      p.tiers = []
      p.models = []
      return
    }
    const remaining = p.tiers.filter((_, i) => i !== t)
    const seen = new Map<string, DraftModel>()
    for (const m of p.models) {
      const keys = m.optionKeys.filter((_, i) => i !== t)
      const k = keys.join('|')
      const existing = seen.get(k)
      if (!existing) {
        // Only an unambiguous collapse keeps the source link
        seen.set(k, { ...m, optionKeys: keys, sourceModelId: p.tiers[t].options.length === 1 ? m.sourceModelId : null })
      } else {
        existing.stock = (existing.stock ?? 0) + (m.stock ?? 0)
      }
    }
    p.tiers = remaining
    p.models = regenerateModels(p.tiers, [...seen.values()], fallback())
  })

  const applyBulk = () => mutate((p) => {
    const price = num(bulk.price)
    const stock = num(bulk.stock)
    for (const m of p.models) {
      if (price !== null) m.price = price
      if (stock !== null) m.stock = Math.trunc(stock)
      if (bulk.sku.trim()) m.sku = bulk.sku.trim()
    }
  })

  return (
    <Section id="section-penjualan" title="Informasi Penjualan">
      <Field label="SKU Induk">
        <input value={payload.itemSku} onChange={(e) => mutate((p) => { p.itemSku = e.target.value })} className="input" />
      </Field>

      {tiers.length === 0 ? (
        <>
          <Field label="Harga" required>
            <input type="number" min={L.priceMin} value={payload.price ?? ''} onChange={(e) => mutate((p) => { p.price = num(e.target.value) })} className="input" />
          </Field>
          <Field label="Stok" required>
            <input type="number" min={0} value={payload.stock ?? ''} onChange={(e) => mutate((p) => { p.stock = num(e.target.value) })} className="input" />
          </Field>
          <Field label="Variasi">
            <button type="button" onClick={addTier} className="btn-secondary text-sm flex items-center gap-1"><Plus className="w-4 h-4" /> Aktifkan Variasi</button>
          </Field>
        </>
      ) : (
        <>
          {tiers.map((tier, t) => (
            <Field key={t} label={`Variasi ${t + 1}`}>
              <div className="rounded bg-gray-50 dark:bg-slate-800/60 p-3 space-y-2 relative">
                <button type="button" onClick={() => removeTier(t)} className="absolute right-2 top-2 text-gray-400 hover:text-red-600" aria-label="Hapus variasi"><X className="w-4 h-4" /></button>
                <div className="grid grid-cols-[4.5rem_1fr] gap-2 items-center pr-6">
                  <span className="text-xs text-gray-600 dark:text-slate-300">Nama</span>
                  <div className="relative">
                    <input value={tier.name} onChange={(e) => mutate((p) => { p.tiers[t].name = e.target.value })} className="input pr-14" placeholder="mis. Warna" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2"><Counter value={charCount(tier.name)} max={L.tierNameMax} /></span>
                  </div>
                </div>
                {tier.options.map((opt, o) => (
                  <div key={opt.key} className="grid grid-cols-[4.5rem_1fr_auto] gap-2 items-center">
                    <span className="text-xs text-gray-600 dark:text-slate-300">{o === 0 ? 'Pilihan' : ''}</span>
                    <div className="relative">
                      <input value={opt.name} onChange={(e) => mutate((p) => { p.tiers[t].options[o].name = e.target.value })} className="input pr-14" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2"><Counter value={charCount(opt.name)} max={L.optionMax} /></span>
                    </div>
                    <button
                      type="button"
                      disabled={tier.options.length <= 1}
                      onClick={() => withTiers((ts) => { ts[t].options.splice(o, 1) })}
                      className="p-1 text-gray-500 hover:text-red-600 disabled:opacity-30"
                      aria-label="Hapus pilihan"
                    ><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
                <div className="grid grid-cols-[4.5rem_1fr] gap-2">
                  <span />
                  <button
                    type="button"
                    onClick={() => withTiers((ts) => { ts[t].options.push({ key: newOptionKey(), name: '', sourceName: null, image: null }) })}
                    className="rounded border border-dashed border-primary-400 py-1.5 text-sm text-primary-700 dark:text-primary-300 flex items-center justify-center gap-1"
                  ><Plus className="w-4 h-4" /> Tambah Pilihan</button>
                </div>
              </div>
            </Field>
          ))}
          {tiers.length < 2 && (
            <Field label="">
              <button type="button" onClick={addTier} className="btn-secondary text-sm flex items-center gap-1"><Plus className="w-4 h-4" /> Tambah Variasi 2</button>
            </Field>
          )}

          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2">
              <input type="number" placeholder="Rp Harga" value={bulk.price} onChange={(e) => setBulk({ ...bulk, price: e.target.value })} className="input" />
              <input type="number" placeholder="Stok" value={bulk.stock} onChange={(e) => setBulk({ ...bulk, stock: e.target.value })} className="input" />
              <input placeholder="SKU" value={bulk.sku} onChange={(e) => setBulk({ ...bulk, sku: e.target.value })} className="input" />
              <button
                type="button"
                onClick={applyBulk}
                disabled={!bulk.price && !bulk.stock && !bulk.sku.trim()}
                className="btn-secondary text-sm whitespace-nowrap"
              >Terapkan ke Semua</button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={payload.perModelShipping}
                onChange={(e) => mutate((p) => { p.perModelShipping = e.target.checked })}
                className="rounded border-gray-300 dark:border-slate-600"
              />
              Berat dan ukuran berbeda tiap varian
            </label>
          </div>

          <div className="overflow-x-auto rounded border border-gray-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-slate-800/60 text-left text-xs text-gray-600 dark:text-slate-300">
                <tr>
                  <th className="px-3 py-2 min-w-[8rem]">Nama</th>
                  <th className="px-3 py-2 min-w-[8rem]">Harga (Rp)</th>
                  <th className="px-3 py-2 min-w-[6rem]">Stok</th>
                  <th className="px-3 py-2 min-w-[10rem]">SKU</th>
                  {payload.perModelShipping && <>
                    <th className="px-3 py-2 min-w-[6rem]">Berat (g)</th>
                    <th className="px-3 py-2 min-w-[12rem]">P × L × T (cm)</th>
                  </>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
                {payload.models.map((m, i) => (
                  <tr key={m.optionKeys.join('|')}>
                    <td className="px-3 py-1.5 text-gray-900 dark:text-slate-100">
                      {modelLabel(tiers, m)}
                      {!m.sourceModelId && <span className="block text-[10px] text-gray-500 dark:text-slate-400">baru, tidak terikat master</span>}
                    </td>
                    <td className="px-3 py-1.5"><input type="number" value={m.price ?? ''} onChange={(e) => mutate((p) => { p.models[i].price = num(e.target.value) })} className="input py-1" /></td>
                    <td className="px-3 py-1.5"><input type="number" value={m.stock ?? ''} onChange={(e) => mutate((p) => { p.models[i].stock = num(e.target.value) })} className="input py-1" /></td>
                    <td className="px-3 py-1.5"><input value={m.sku} onChange={(e) => mutate((p) => { p.models[i].sku = e.target.value })} className="input py-1" /></td>
                    {payload.perModelShipping && <>
                      <td className="px-3 py-1.5"><input type="number" value={m.weightGram ?? ''} onChange={(e) => mutate((p) => { p.models[i].weightGram = num(e.target.value) })} className="input py-1" /></td>
                      <td className="px-3 py-1.5">
                        <DimensionInputs value={m.dimension ?? null} onChange={(d) => mutate((p) => { p.models[i].dimension = d })} compact />
                      </td>
                    </>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  )
}

function DimensionInputs({ value, onChange, compact }: { value: DraftPayload['dimension']; onChange: (d: DraftPayload['dimension']) => void; compact?: boolean }) {
  const set = (k: 'length' | 'width' | 'height', v: string) => {
    const next = { length: value?.length ?? 0, width: value?.width ?? 0, height: value?.height ?? 0, [k]: num(v) ?? 0 }
    onChange(next.length || next.width || next.height ? next : null)
  }
  const cls = compact ? 'input py-1 w-16' : 'input'
  return (
    <div className="flex items-center gap-1">
      <input type="number" placeholder="P" value={value?.length || ''} onChange={(e) => set('length', e.target.value)} className={cls} />
      <input type="number" placeholder="L" value={value?.width || ''} onChange={(e) => set('width', e.target.value)} className={cls} />
      <input type="number" placeholder="T" value={value?.height || ''} onChange={(e) => set('height', e.target.value)} className={cls} />
    </div>
  )
}

// ── Informasi Pengiriman ──────────────────────────────────────────────────────

function ShippingSection({ meta, payload, channels, mutate }: {
  meta: DraftMeta; payload: DraftPayload; channels: ChannelDef[] | null; mutate: Mutate
}) {
  const [open, setOpen] = useState<number[]>([])
  const heaviest = useMemo(() => (
    payload.perModelShipping && payload.models.length
      ? Math.max(...payload.models.map((m) => m.weightGram || 0), payload.weightGram || 0)
      : payload.weightGram || 0
  ), [payload])

  const shopChannels = channels?.filter((c) => c.enabled) ?? null
  const offered = new Set((shopChannels ?? []).map((c) => c.channelId))
  const lost = meta.source.logistics.filter((l) => l.enabled && shopChannels && !offered.has(l.channelId))

  const toggle = (channelId: number, name: string, enabled: boolean) => mutate((p) => {
    const hit = p.logistics.find((l) => l.channelId === channelId)
    if (hit) hit.enabled = enabled
    else p.logistics.push({ channelId, name, enabled })
  })

  return (
    <Section id="section-pengiriman" title="Informasi Pengiriman">
      <Field label="Berat (gram)" required>
        <input type="number" min={1} value={payload.weightGram ?? ''} onChange={(e) => mutate((p) => { p.weightGram = num(e.target.value) })} className="input" />
      </Field>
      <Field label="Ukuran Paket (cm)">
        <DimensionInputs value={payload.dimension} onChange={(d) => mutate((p) => { p.dimension = d })} />
      </Field>

      <Field label="Jasa Kirim" required>
        {shopChannels === null ? (
          <div className="space-y-1">
            <p className="text-xs text-amber-800 dark:text-amber-300">Daftar jasa kirim toko ini tidak terbaca. Pilihan dari produk asal:</p>
            {payload.logistics.map((l) => (
              <label key={l.channelId} className="flex items-center gap-2 text-sm text-gray-800 dark:text-slate-200">
                <input type="checkbox" checked={l.enabled} onChange={(e) => toggle(l.channelId, l.name, e.target.checked)} className="rounded border-gray-300 dark:border-slate-600" />
                {l.name || l.channelId}
              </label>
            ))}
          </div>
        ) : (
          <div className="rounded border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-700/60">
            <p className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-slate-100">{meta.targetStore.name}</p>
            {shopChannels.map((c) => {
              const tooHeavy = c.maxWeightKg > 0 && heaviest > c.maxWeightKg * 1000
              const checked = payload.logistics.find((l) => l.channelId === c.channelId)?.enabled ?? false
              const couriers = c.couriers.filter((k) => k.enabled)
              const isOpen = open.includes(c.channelId)
              return (
                <div key={c.channelId} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {couriers.length > 0 ? (
                      <button type="button" onClick={() => setOpen((s) => (isOpen ? s.filter((x) => x !== c.channelId) : [...s, c.channelId]))} className="text-gray-500">
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>
                    ) : <span className="w-4" />}
                    <span className={`flex-1 text-sm ${tooHeavy ? 'text-gray-400 dark:text-slate-500' : 'text-gray-800 dark:text-slate-200'}`}>
                      {c.name}
                      {c.maxWeightKg > 0 && <span className="text-xs text-gray-500 dark:text-slate-400"> (maks {(c.maxWeightKg * 1000).toLocaleString('id-ID')}g)</span>}
                      {tooHeavy && <span className="block text-xs text-red-600 dark:text-red-400">Produk terlalu berat untuk jasa kirim ini</span>}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked && !tooHeavy}
                      disabled={tooHeavy}
                      onChange={(e) => toggle(c.channelId, c.name, e.target.checked)}
                      className="rounded border-gray-300 dark:border-slate-600 w-4 h-4"
                    />
                  </div>
                  {isOpen && (
                    <p className="ml-6 mt-1 text-xs text-gray-500 dark:text-slate-400">{couriers.map((k) => k.name).join(', ')}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {lost.length > 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Tidak aktif di toko ini, jadi tidak ikut: {lost.map((l) => l.name).join(', ')}
          </p>
        )}
      </Field>
    </Section>
  )
}

// ── Lainnya ───────────────────────────────────────────────────────────────────

function OtherSection({ payload, limits: L, mutate }: { payload: DraftPayload; limits: FormOptions['limits']; mutate: Mutate }) {
  return (
    <Section id="section-lainnya" title="Lainnya">
      <Field label="Kondisi">
        <select value={payload.condition} onChange={(e) => mutate((p) => { p.condition = e.target.value === 'USED' ? 'USED' : 'NEW' })} className="input">
          <option value="NEW">Baru</option>
          <option value="USED">Bekas</option>
        </select>
      </Field>
      <Field label="Pre-order" hint={payload.preOrder.enabled ? `Dikirim dalam ${L.daysToShipMin}–${L.daysToShipMax} hari` : undefined}>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-slate-200">
            <input
              type="checkbox"
              checked={payload.preOrder.enabled}
              onChange={(e) => mutate((p) => { p.preOrder = { enabled: e.target.checked, daysToShip: e.target.checked ? (p.preOrder.daysToShip || L.daysToShipMin) : p.preOrder.daysToShip } })}
              className="rounded border-gray-300 dark:border-slate-600"
            />
            Ya
          </label>
          {payload.preOrder.enabled && (
            <input
              type="number"
              min={L.daysToShipMin}
              max={L.daysToShipMax}
              value={payload.preOrder.daysToShip ?? ''}
              onChange={(e) => mutate((p) => { p.preOrder.daysToShip = num(e.target.value) })}
              className="input w-24"
            />
          )}
        </div>
      </Field>
    </Section>
  )
}
