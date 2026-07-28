import api from './api'
import Cookies from 'js-cookie'

export interface User {
  id: string
  name: string
  email: string
  role: 'ADMIN' | 'STAFF'
  storeAccess?: { id: string; name: string }[]
}

export interface LoginResponse {
  accessToken: string
  refreshToken: string
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>('/auth/login', { email, password })
  const data = res.data
  const token = data.accessToken || (data as any).token
  if (token) {
    Cookies.set('token', token, { expires: 7, sameSite: 'lax' })
  }
  // Persist refresh token so the silent-refresh interceptor in api.ts can use it
  const refreshToken = data.refreshToken || (data as any).refresh_token
  if (refreshToken) {
    Cookies.set('refreshToken', refreshToken, { expires: 7, sameSite: 'lax' })
  }
  return data
}

export async function logout(): Promise<void> {
  Cookies.remove('token')
  Cookies.remove('refreshToken')
  if (typeof window !== 'undefined') {
    window.location.href = '/login'
  }
}

export async function getMe(): Promise<User> {
  const res = await api.get<User>('/auth/me')
  return res.data
}

export function getToken(): string | undefined {
  return Cookies.get('token')
}
