import api from '@/lib/api'

/**
 * A readable message from a failed request, whose body is a Blob when the
 * request asked for a file — the JSON error is inside it, not on it.
 */
export async function readFileError(err: any, fallback: string): Promise<string> {
  const body = err?.response?.data
  if (body instanceof Blob) {
    try {
      return JSON.parse(await body.text())?.error || fallback
    } catch {
      return fallback
    }
  }
  return body?.error || fallback
}

/**
 * GET a file from the API and hand it to the browser as a download, named as
 * the server suggests.
 */
export async function downloadFile(path: string, params: Record<string, string>, fallbackName: string) {
  const res = await api.get(path, { params, responseType: 'blob', timeout: 300_000 })
  const disposition = res.headers?.['content-disposition'] || ''
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName

  const url = window.URL.createObjectURL(res.data as Blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}
