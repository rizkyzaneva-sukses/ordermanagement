import axios from 'axios'
import Cookies from 'js-cookie'

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api',
  headers: {
    'Content-Type': 'application/json',
  },
  // Axios has no timeout by default. A backend call that hangs (a marketplace
  // API that never answers, a stuck DB query) used to spin the calling button
  // forever with no way out but a page reload. This is a safety net sized well
  // above the backend's own worst case for a single Shopee call (~30s per
  // attempt, up to 3 attempts) — it exists to eventually surface a hung request
  // as an error, not to enforce a snappy UX.
  timeout: 90_000,
})

// ── Request interceptor: attach JWT access token ──────────────────────────────
api.interceptors.request.use(
  (config) => {
    const token = Cookies.get('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// ── Response interceptor: unwrap data + silent JWT refresh on 401 ─────────────
//
// Strategy on 401:
//   1. Check if we have a refreshToken cookie.
//   2. Call POST /auth/refresh — if it succeeds, store the new access token and
//      retry the original request transparently (user never sees a redirect).
//   3. Only redirect to /login if the refresh call itself fails or there's no
//      refresh token stored.
//
// The `_retry` flag prevents an infinite loop if /auth/refresh itself returns 401.

let isRefreshing = false
let pendingRequests: Array<(token: string) => void> = []

function onTokenRefreshed(newToken: string) {
  pendingRequests.forEach((cb) => cb(newToken))
  pendingRequests = []
}

function redirectToLogin() {
  Cookies.remove('token')
  Cookies.remove('refreshToken')
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login'
  }
}

api.interceptors.response.use(
  (response) => {
    // Unwrap { success: true, data: ... } envelope
    if (
      response.data &&
      typeof response.data === 'object' &&
      response.data.success === true &&
      'data' in response.data
    ) {
      response.data = response.data.data
    }
    return response
  },
  async (error) => {
    const originalRequest = error.config

    // Only attempt refresh on 401, and only once per request (_retry guard)
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error)
    }

    const storedRefreshToken = Cookies.get('refreshToken')
    if (!storedRefreshToken) {
      redirectToLogin()
      return Promise.reject(error)
    }

    originalRequest._retry = true

    // If a refresh is already in flight, queue this request to retry once done
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingRequests.push((newToken: string) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          resolve(api(originalRequest))
        })
      })
    }

    isRefreshing = true

    try {
      const { data } = await axios.post(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/auth/refresh`,
        { refreshToken: storedRefreshToken }
      )

      // Backend wraps response in { success, data: { accessToken, refreshToken } }
      const payload = data?.data ?? data
      const newAccessToken: string = payload?.accessToken
      const newRefreshToken: string = payload?.refreshToken

      if (!newAccessToken) throw new Error('No access token in refresh response')

      // Persist new tokens
      Cookies.set('token', newAccessToken, { expires: 7, sameSite: 'lax' })
      if (newRefreshToken) {
        Cookies.set('refreshToken', newRefreshToken, { expires: 7, sameSite: 'lax' })
      }

      // Notify queued requests and retry original
      onTokenRefreshed(newAccessToken)
      originalRequest.headers.Authorization = `Bearer ${newAccessToken}`
      return api(originalRequest)
    } catch (refreshError) {
      // Refresh failed — session is truly expired, send to login
      pendingRequests = []
      redirectToLogin()
      return Promise.reject(refreshError)
    } finally {
      isRefreshing = false
    }
  }
)

export default api

