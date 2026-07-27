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
  return data
}

export async function logout(): Promise<void> {
  Cookies.remove('token')
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
