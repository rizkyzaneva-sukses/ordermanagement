# PRD — Stok Master Berkurang Otomatis dari Pesanan

> Status: **disetujui 10 Okt 2026, sudah dibangun** · draf 9 Okt 2026
> Patokan: keluhan operator 9 Okt ("edit stok di OrderPro tapi di Shopee tidak berubah"), Daftar Stok Komplace, dan keputusan Rizky 9 Okt.

## 1. Overview

Sampai 9 Okt, stok master di OrderPro hanya berubah kalau operator mengetik angka baru. Shopee mengurangi stok tokonya sendiri saat ada penjualan, tapi toko lain yang menjual barang yang sama tidak tahu. Akibatnya angka antartoko berbeda jauh (Zora Cap White: master 107, Shopee 17), dan operator harus menyamakannya dengan tangan.

Fitur ini membuat **stok master berkurang sendiri saat ada pesanan yang dibayar**, lalu angka barunya **dikirim ke semua toko** yang menjual barang itu. Dengan begitu satu stok fisik dipakai bersama oleh semua toko, seperti Komplace.

Ini membalik keputusan "stok diisi manual" tanggal 7 Sep 2026. Keputusan **tanpa bundling** tetap berlaku: stok bundle tidak mengurangi stok komponennya.

---

## 2. Keputusan yang sudah diambil (Rizky, 9 Okt 2026)

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Kapan stok dikurangi | **Saat pesanan dibayar.** Pesanan Belum Bayar tidak mengurangi stok. COD langsung dihitung karena masuk sebagai Perlu Dikirim |
| 2 | Pesanan batal setelah stok dikurangi | **Stok kembali otomatis**, lalu dikirim ulang ke semua toko |
| 3 | Retur (sudah dikirim, dikembalikan pembeli) | **Manual**, seperti Komplace. Operator mengecek fisik barang lalu menambah lewat Edit Stok |
| 4 | Titik awal | **Stock opname dulu**, baru fitur dinyalakan. Hanya pesanan setelah fitur menyala yang dihitung |
| 5 | Kapan stok dikirim ke Shopee | Otomatis (sudah dibangun 9 Okt untuk Edit Stok, dipakai ulang di sini) |

---

## 3. Requirements

- **Pengguna:** operator. Menyalakan atau mematikan fitur hanya boleh **ADMIN**
- **Sumber data:** pesanan yang sudah disinkron OrderPro dari Shopee (tiap 15 menit, dan lebih cepat kalau webhook Shopee aktif)
- **Platform:** Shopee saja. TikTok menyusul setelah integrasinya ada
- **Constraint:**
  - Sinkron membaca pesanan yang sama berkali-kali, jadi satu pesanan **tidak boleh** mengurangi stok dua kali
  - Barang dari listing yang **belum dipetakan** ke master diabaikan. Pesanan itu tidak mengurangi apa pun, termasuk kalau listingnya baru dipetakan belakangan
  - Stok master tidak pernah di bawah 0. Kalau pesanan membuatnya minus, stok jadi 0 dan dicatat di Riwayat Stok sebagai kemungkinan oversell

---

## 4. Core Features

### 4.1 Pengurangan dari pesanan — Must-have
- Setiap selesai sinkron satu toko, OrderPro mencari pesanan toko itu yang sudah dibayar dan belum pernah dihitung:
  - Status: `READY_TO_SHIP`, `PROCESSED`, `RETRY_SHIP`, `SHIPPED`, `TO_CONFIRM_RECEIVE`, `COMPLETED`, `IN_CANCEL`, `TO_RETURN`. Pada dasarnya semua status kecuali `UNPAID` dan `CANCELLED`
  - Dibuat pada atau setelah waktu fitur dinyalakan
- Tiap barang dicocokkan lewat `item_id` + `model_id`, lalu listing, lalu master, kemudian stok master dikurangi sebanyak jumlah yang dibeli
- Pesanan yang dipecah jadi beberapa paket tetap dihitung **satu kali per pesanan**, bukan per paket
- Pesanan ditandai sudah dihitung, jadi sinkron berikutnya tidak menghitungnya lagi

### 4.2 Pengembalian saat batal — Must-have
- Pesanan yang sudah mengurangi stok lalu berstatus `CANCELLED` mengembalikan stoknya, **kecuali** pesanan itu sempat dikirim. Pesanan yang gagal antar lalu dibatalkan termasuk retur, dan retur ditangani manual (keputusan 3)
- "Sempat dikirim" berarti OrderPro pernah melihat pesanan itu berstatus `SHIPPED` / `TO_CONFIRM_RECEIVE` / `COMPLETED`, atau status logistiknya sudah melewati serah ke kurir
- `IN_CANCEL` (pembeli minta batal) belum mengembalikan stok. Stok baru kembali kalau pembatalannya benar-benar jadi

### 4.3 Kirim ke semua toko — Must-have
- Setelah satu putaran sinkron, semua master yang stoknya berubah dikirim sekaligus ke semua listing Shopee yang terikat, **termasuk toko asal pesanan**. Dengan begitu semua toko memegang angka yang sama
- Kegagalan kirim dicatat di log server (`[orderStock] Push failed`). Kolom "Di Shopee" di Daftar Stok menunjukkan toko yang angkanya belum sama, dan simpan ulang di Edit Stok mengirim ulang

### 4.4 Riwayat Stok — Must-have
Seperti menu Riwayat Stok di Komplace. Tanpa ini, operator tidak bisa menjawab "kenapa stok White tiba-tiba 12?".
- Klik master di Daftar Stok untuk membuka riwayatnya, terbaru di atas
- Kolom: waktu (WIB), jenis (**Pesanan** / **Batal** / **Edit manual**), perubahan (−2, +2, atau 30 → 25), stok jadi, no. pesanan dan toko (untuk Pesanan/Batal), user (untuk Edit manual)
- Edit Stok satuan maupun massal juga tercatat, supaya riwayatnya lengkap

### 4.5 Saklar fitur + stock opname — Must-have
- Di Daftar Stok ada panel **"Kurangi stok otomatis dari pesanan"** dengan status Mati/Menyala dan sejak kapan menyala
- Menyalakan hanya bisa dilakukan ADMIN, lewat dialog konfirmasi:
  > Sebelum menyalakan, pastikan stok semua master sudah benar (stock opname). Isi dengan **stok yang bisa dijual**, yaitu stok fisik dikurangi barang untuk pesanan yang sudah dibayar tapi belum dikirim. Hanya pesanan yang masuk setelah ini yang mengurangi stok.
- Mematikan menghentikan pengurangan berikutnya. Riwayat tetap ada
- Teks di bawah judul Daftar Stok mengikuti status saklar

### 4.6 Nice-to-have (tidak dikerjakan sekarang)
- Export/Import stok (Excel) untuk stock opname massal
- Notifikasi kalau ada master yang jadi 0 karena oversell
- Pengaturan per toko (misalnya toko tertentu tidak ikut memakai stok bersama)

---

## 5. Perubahan data

Hanya **menambah**, tidak ada kolom yang dihapus atau diubah.

```prisma
// Satu baris per perubahan stok master — dasar Riwayat Stok, sekaligus
// pengaman agar satu pesanan tidak mengurangi stok dua kali.
model StockMovement {
  id         String   @id @default(cuid())
  productId  String
  kind       String   // ORDER | CANCEL | MANUAL
  delta      Int      // -2, +2, atau selisih edit manual
  stockAfter Int
  storeId    String?  // ORDER / CANCEL
  orderId    String?  // order_sn
  itemId     String?
  modelId    String?
  userId     String?  // MANUAL
  note       String?  // mis. "stok minus, diisi 0"
  createdAt  DateTime @default(now())

  // Satu pesanan × satu varian × satu jenis = paling banyak satu baris.
  // Baris MANUAL tidak terkena karena kolom-kolomnya NULL.
  @@unique([storeId, orderId, itemId, modelId, kind])
  @@index([productId, createdAt])
}

// Pengaturan aplikasi sederhana (key → value).
model AppSetting {
  key       String   @id    // "stockAutoDeductSince": ISO time, atau tidak ada = mati
  value     String
  updatedAt DateTime @updatedAt
}
```

Plus satu kolom di `Order`: `stockCountedAt DateTime?`, supaya sinkron tidak memindai ulang pesanan yang sudah dihitung.

---

## 6. Risiko yang sudah diketahui

| Risiko | Dampak | Penanganan |
|---|---|---|
| Pesanan Belum Bayar sudah mengurangi stok di toko asalnya (oleh Shopee), sedangkan master belum. Push berikutnya mengembalikan angka toko itu ke angka master | Toko asal bisa menjual 1 unit lebih sampai pesanan dibayar | Konsekuensi keputusan 1. Biasanya kecil |
| Jeda sinkron (maks. 15 menit tanpa webhook) | Barang terakhir bisa terjual di dua toko dalam jeda itu | Webhook Shopee mempersingkat jeda |
| Operator mengetik stok baru tepat saat pesanan sedang mengurangi stok | Pengurangan itu tertimpa | Edit manual tercatat di Riwayat, dan kolom "Di Shopee" membantu mengecek |
| Opname salah | Semua toko mewarisi angka yang salah | Ditegaskan di dialog saklar |

---

## 7. Urutan pengerjaan

1. Migrasi (`StockMovement`, `AppSetting`, `Order.stockCountedAt`) + logika murni (hitung barang per pesanan, aturan batal) beserta tes
2. Pengurangan dan pengembalian dijalankan setelah sinkron per toko, lalu push sekali per putaran
3. Edit Stok ikut mencatat ke Riwayat
4. UI: panel saklar, Riwayat Stok, teks Daftar Stok
5. Uji di Postgres sementara dengan pesanan tiruan: dibayar, dihitung sekali, batal kembali, retur tidak kembali, paket terpecah

## 8. Belum diuji di produksi

Push stok ke Shopee (9 Okt) belum pernah dicoba ke toko sungguhan. Saran: deploy push dulu, coba satu master, cocokkan dengan Seller Centre, baru lanjut ke fitur ini.
