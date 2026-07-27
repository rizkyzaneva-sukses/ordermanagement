'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import {
  Users,
  Plus,
  Edit2,
  Loader2,
  Shield,
  UserCheck,
  UserX,
} from 'lucide-react'

interface Store {
  id: string
  name: string
}

interface UserData {
  id: string
  name: string
  email: string
  role: 'ADMIN' | 'STAFF'
  status: 'ACTIVE' | 'INACTIVE'
  storeAccess: { id: string; name: string }[]
}

const roleBadge: Record<string, string> = {
  ADMIN: 'bg-purple-100 text-purple-800 dark:bg-purple-950/70 dark:text-purple-300',
  STAFF: 'bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300',
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserData[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState<UserData | null>(null)
  const [saving, setSaving] = useState(false)

  // Form state
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formRole, setFormRole] = useState<'ADMIN' | 'STAFF'>('STAFF')
  const [formStoreIds, setFormStoreIds] = useState<string[]>([])

  const fetchUsers = async () => {
    try {
      const res = await api.get<any>('/users')
      const rawUsers = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      const formatted = rawUsers.map((u: any) => ({
        ...u,
        status: u.status || (u.isActive ? 'ACTIVE' : 'INACTIVE'),
        storeAccess: u.storeAccess || (u.stores ? u.stores.map((s: any) => ({ id: s.id, name: s.name })) : []),
      }))
      setUsers(formatted)
    } catch (err) {
      console.error('Failed to fetch users', err)
      setUsers([])
    }
  }

  const fetchStores = async () => {
    try {
      const res = await api.get<any>('/stores')
      const rawStores = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setStores(rawStores)
    } catch {
      setStores([])
    }
  }

  useEffect(() => {
    Promise.all([fetchUsers(), fetchStores()]).finally(() => setLoading(false))
  }, [])

  const openCreate = () => {
    setEditingUser(null)
    setFormName('')
    setFormEmail('')
    setFormPassword('')
    setFormRole('STAFF')
    setFormStoreIds([])
    setShowModal(true)
  }

  const openEdit = (user: UserData) => {
    setEditingUser(user)
    setFormName(user.name)
    setFormEmail(user.email)
    setFormPassword('')
    setFormRole(user.role)
    setFormStoreIds(user.storeAccess.map((s) => s.id))
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!formName.trim()) return
    setSaving(true)
    try {
      if (editingUser) {
        await api.put(`/users/${editingUser.id}`, {
          name: formName,
          role: formRole,
          password: formPassword || undefined,
          storeIds: formStoreIds,
        })
      } else {
        await api.post('/users', {
          name: formName,
          email: formEmail,
          password: formPassword,
          role: formRole,
          storeIds: formStoreIds,
        })
      }
      setShowModal(false)
      await fetchUsers()
    } catch (err) {
      console.error('Failed to save user', err)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleStatus = async (user: UserData) => {
    try {
      await api.put(`/users/${user.id}`, {
        status: user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      })
      await fetchUsers()
    } catch {}
  }

  const toggleStoreAccess = (storeId: string) => {
    setFormStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600 dark:text-primary-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Kelola User</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Atur hak akses staff dan admin sistem</p>
        </div>
        <button onClick={openCreate} className="btn-primary self-start sm:self-auto flex items-center gap-2">
          <Plus className="w-4 h-4" />
          <span>Tambah Staff</span>
        </button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/80">
                <th className="table-header">Nama</th>
                <th className="table-header">Email</th>
                <th className="table-header">Role</th>
                <th className="table-header">Status</th>
                <th className="table-header">Akses Toko</th>
                <th className="table-header text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <Users className="w-12 h-12 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                    <p className="font-medium text-gray-900 dark:text-slate-200">Belum ada user</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Klik "Tambah Staff" untuk menambahkan</p>
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                    <td className="table-cell">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-primary-100 dark:bg-primary-950 rounded-full flex items-center justify-center">
                          <span className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                            {user.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <span className="font-medium text-gray-900 dark:text-slate-100">{user.name}</span>
                      </div>
                    </td>
                    <td className="table-cell text-gray-500 dark:text-slate-400">{user.email}</td>
                    <td className="table-cell">
                      <span className={`badge ${roleBadge[user.role]}`}>
                        {user.role === 'ADMIN' && <Shield className="w-3 h-3 mr-1" />}
                        {user.role}
                      </span>
                    </td>
                    <td className="table-cell">
                      <span
                        className={`badge ${
                          user.status === 'ACTIVE'
                            ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400'
                        }`}
                      >
                        {user.status === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="table-cell">
                      {user.storeAccess.length === 0 ? (
                        <span className="text-gray-400 dark:text-slate-500 text-sm">Semua toko</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {user.storeAccess.map((s) => (
                            <span key={s.id} className="badge bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300">
                              {s.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(user)} className="btn-ghost p-2" title="Edit User">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleToggleStatus(user)}
                          className={`btn-ghost p-2 ${
                            user.status === 'ACTIVE' ? 'text-red-500 hover:text-red-700 dark:text-red-400' : 'text-green-500 hover:text-green-700 dark:text-green-400'
                          }`}
                          title={user.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                        >
                          {user.status === 'ACTIVE' ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md border border-gray-200 dark:border-slate-700 my-8">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 dark:text-slate-100">
                {editingUser ? 'Edit User' : 'Tambah Staff'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200 text-xl font-bold"
              >
                ×
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="label">Nama Lengkap</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="input"
                  placeholder="Nama lengkap staff"
                />
              </div>
              {!editingUser && (
                <div>
                  <label className="label">Email</label>
                  <input
                    type="email"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    className="input"
                    placeholder="email@perusahaan.com"
                  />
                </div>
              )}
              <div>
                <label className="label">
                  {editingUser ? 'Password Baru (kosongkan jika tidak diubah)' : 'Password'}
                </label>
                <input
                  type="password"
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  className="input"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="label">Role</label>
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value as 'ADMIN' | 'STAFF')}
                  className="input"
                >
                  <option value="STAFF">Staff Toko</option>
                  <option value="ADMIN">Administrator</option>
                </select>
              </div>
              <div>
                <label className="label">Akses Toko</label>
                <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">Pilih toko yang dapat diakses staff (Kosongkan = akses semua)</p>
                <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-200 dark:border-slate-700 rounded-lg p-3 bg-gray-50 dark:bg-slate-900/40">
                  {stores.map((store) => (
                    <label key={store.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formStoreIds.includes(store.id)}
                        onChange={() => toggleStoreAccess(store.id)}
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-slate-300">{store.name}</span>
                    </label>
                  ))}
                  {stores.length === 0 && (
                    <p className="text-sm text-gray-400 dark:text-slate-500">Belum ada toko</p>
                  )}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-3 bg-gray-50 dark:bg-slate-800/50 rounded-b-xl">
              <button onClick={() => setShowModal(false)} className="btn-secondary">
                Batal
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingUser ? 'Simpan' : 'Tambah Staff'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
