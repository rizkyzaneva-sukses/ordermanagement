/**
 * Shapes and helpers for Salin Produk drafts, shared by the Draf tab and the
 * Edit Produk form. The payload mirrors src/services/productCopy.js — that file
 * is the authority; this one only has to agree with it.
 */

export interface ImageRef {
  /** Set once the image lives in Shopee media space (uploaded from the form). */
  imageId?: string | null
  /** Where the image can be seen, and downloaded from at Publish if no imageId. */
  url?: string | null
  sourceImageId?: string | null
}

export type DescriptionBlock =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & ImageRef)

export interface AttributeValue {
  valueId: number
  name: string
  unit: string
}

export interface DraftAttribute {
  attributeId: number
  name: string
  values: AttributeValue[]
}

export interface TierOption {
  key: string
  name: string
  sourceName: string | null
  image: ImageRef | null
}

export interface Tier {
  name: string
  options: TierOption[]
}

export interface Dimension {
  length: number
  width: number
  height: number
}

export interface DraftModel {
  optionKeys: string[]
  sourceModelId: string | null
  price: number | null
  stock: number | null
  sku: string
  weightGram?: number | null
  dimension?: Dimension | null
}

export interface DraftLogistic {
  channelId: number
  name: string
  enabled: boolean
}

export interface DraftPayload {
  name: string
  descriptionType: 'normal' | 'extended'
  description: string
  descriptionBlocks: DescriptionBlock[]
  categoryId: number | null
  brand: { id: number; name: string }
  attributes: DraftAttribute[]
  images: ImageRef[]
  sizeChart:
    | ({ kind: 'image' } & ImageRef)
    | { kind: 'template'; templateId: number; fromSource?: boolean }
    | null
  tiers: Tier[]
  models: DraftModel[]
  itemSku: string
  price: number | null
  stock: number | null
  weightGram: number | null
  dimension: Dimension | null
  perModelShipping: boolean
  logistics: DraftLogistic[]
  condition: 'NEW' | 'USED'
  preOrder: { enabled: boolean; daysToShip: number | null }
  itemDangerous: number
}

export type DraftStatus = 'DRAFT' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED'

export interface DraftSummary {
  id: string
  status: DraftStatus
  name: string
  imageUrl: string | null
  itemSku: string
  priceMin: number | null
  priceMax: number | null
  stockTotal: number
  variants: { name: string; price: number | null; stock: number | null; sku: string }[]
  sourceStore: { id: string; name: string }
  sourceItemId: string
  targetStore: { id: string; name: string }
  publishedItemId: string | null
  lastError: string | null
  lastErrorRaw: Record<string, unknown> | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ValidationError {
  field: string
  message: string
}

export interface Limits {
  nameMin: number
  nameMax: number
  descriptionMin: number
  descriptionMax: number
  extendedTextMin: number
  extendedTextMax: number
  extendedImageMin: number
  extendedImageMax: number
  imageMin: number
  imageMax: number
  tierNameMax: number
  optionMax: number
  priceMin: number
  priceMax: number
  stockMin: number
  stockMax: number
  daysToShipMin: number
  daysToShipMax: number
  weightMandatory: boolean
  sizeChartMandatory: boolean
}

export interface AttributeDef {
  attributeId: number
  name: string
  mandatory: boolean
  inputType: 'select' | 'combo' | 'text' | 'multiselect' | 'multicombo'
  maxValues: number | null
  units: string[]
  values: AttributeValue[]
}

export interface ChannelDef {
  channelId: number
  name: string
  enabled: boolean
  maxWeightKg: number
  couriers: { name: string; enabled: boolean }[]
}

export interface FormOptions {
  limits: Limits
  attributes: AttributeDef[]
  channels: ChannelDef[] | null
  brandMandatory: boolean
  warnings: string[]
  errors: ValidationError[]
}

export const STATUS_LABEL: Record<DraftStatus, string> = {
  DRAFT: 'Draf',
  PUBLISHING: 'Sedang Publish',
  PUBLISHED: 'Terbit',
  FAILED: 'Gagal',
}

export const STATUS_CLASS: Record<DraftStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-slate-200',
  PUBLISHING: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  PUBLISHED: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

export const rupiah = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `Rp ${n.toLocaleString('id-ID')}`

/** Characters as Shopee counts them: an emoji is one. */
export const charCount = (s: string | null | undefined) => [...(s ?? '')].length

export function imageSrc(img: ImageRef | null | undefined): string | null {
  return img?.url || null
}

let keySeq = 0
export function newOptionKey(): string {
  keySeq += 1
  return `n${Date.now().toString(36)}${keySeq}`
}

/** Every option combination, first tier outermost — Shopee's order. */
export function combinations(tiers: Tier[]): string[][] {
  return tiers.reduce<string[][]>(
    (acc, tier) => acc.flatMap((prefix) => tier.options.map((o) => [...prefix, o.key])),
    [[]],
  )
}

/**
 * Rebuild the model list after the variations change, keeping every existing
 * row that still applies — its price, stock, SKU and link to the source.
 *
 * A combination that did not exist before borrows price and SKU from the
 * nearest relative (same first option), so adding "XL" does not start at a
 * blank price. It gets no source link: it was not copied from anything.
 */
export function regenerateModels(
  tiers: Tier[],
  models: DraftModel[],
  fallback: { price: number | null; stock: number | null; sku: string },
): DraftModel[] {
  if (tiers.length === 0) return []
  const exact = new Map(models.map((m) => [m.optionKeys.join('|'), m]))
  return combinations(tiers).map((keys) => {
    const hit = exact.get(keys.join('|'))
    if (hit) return hit
    const relative = models.find((m) => m.optionKeys[0] === keys[0]) ?? models[0]
    return {
      optionKeys: keys,
      sourceModelId: null,
      price: relative?.price ?? fallback.price,
      stock: relative ? 0 : fallback.stock,
      sku: relative?.sku ?? fallback.sku,
      weightGram: relative?.weightGram ?? null,
      dimension: relative?.dimension ?? null,
    }
  })
}

export function modelLabel(tiers: Tier[], model: DraftModel): string {
  return model.optionKeys
    .map((key, t) => tiers[t]?.options.find((o) => o.key === key)?.name || '?')
    .join(' / ')
}

/** Which form section a validation error belongs to, for scrolling to it. */
export function sectionOf(field: string): string {
  if (field === 'name' || field === 'description' || field === 'category') return 'section-dasar'
  if (field === 'brand' || field.startsWith('attribute:')) return 'section-atribut'
  if (field === 'images' || field === 'sizeChart') return 'section-media'
  if (field.startsWith('tier') || field === 'models' || field === 'price') return 'section-penjualan'
  if (field === 'weight' || field === 'logistics') return 'section-pengiriman'
  return 'section-lainnya'
}

export function apiError(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.message || fallback
}
