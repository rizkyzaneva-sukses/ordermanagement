/**
 * Every explanation behind a "?" in the app, in one place.
 *
 * Kept here rather than next to each label so the same word says the same thing
 * on every screen — "Siap Kirim" on the dashboard and in the orders list is one
 * entry, not two paragraphs that drift apart — and so a definition can be
 * corrected without hunting through JSX.
 *
 * Written for the person packing parcels, not the person who built the app:
 * what the thing *is*, then what to *do* about it. Status meanings follow
 * shopee-order-management-kb.md; anything OrderPro adds on top (print flag,
 * master stock, sync check) is described as OrderPro behaves today.
 */

export interface GlossaryEntry {
  title: string
  body?: string
  /** A definition list, for one "?" that explains a whole group (every tab, every sort). */
  items?: readonly { readonly term: string; readonly text: string }[]
  /** What to do next, or why it matters. Shown last, set apart. */
  hint?: string
}

export const GLOSSARY = {
  // ── Status pesanan ────────────────────────────────────────────────────────
  'status.UNPAID': {
    title: 'Belum Bayar',
    body: 'Pembeli sudah membuat pesanan tetapi belum membayar. Belum ada yang perlu dikirim, dan stok master belum dikurangi.',
    hint: 'Kalau tidak dibayar sampai batas waktu, Shopee membatalkannya sendiri.',
  },
  'status.READY_TO_SHIP': {
    title: 'Siap Kirim',
    body: 'Sudah dibayar dan menunggu kamu mengatur pengiriman: pilih dijemput kurir atau diantar ke counter. Di tahap inilah stok master berkurang (kalau Stok Otomatis menyala).',
    hint: 'Atur sebelum batas kirim — pesanan yang terlambat diatur dibatalkan otomatis oleh Shopee.',
  },
  'status.PROCESSED': {
    title: 'Sudah Diatur',
    body: 'Pengiriman sudah diatur ke Shopee. Nomor resi bisa saja belum terbit; kalau begitu pakai "Ambil nomor resi". Setelah resi ada: cetak, tempel di paket, lalu serahkan ke kurir.',
    hint: 'Berubah jadi Dikirim setelah kurir memindai paket.',
  },
  'status.RETRY_SHIP': {
    title: 'Pickup Gagal',
    body: 'Kurir gagal menjemput paket. Pengiriman harus dijadwalkan ulang (atau paket diantar sendiri ke counter), kalau tidak pesanan bisa dibatalkan.',
    hint: 'Pakai "Jadwalkan ulang pickup" di menu Aksi, atau tombol massalnya setelah mencentang pesanan.',
  },
  'status.SHIPPED': {
    title: 'Dikirim',
    body: 'Paket sudah di tangan kurir dan sedang diantar. Tidak ada yang perlu kamu lakukan.',
  },
  'status.TO_CONFIRM_RECEIVE': {
    title: 'Menunggu Konfirmasi',
    body: 'Paket sudah sampai dan menunggu pembeli menekan "Pesanan Diterima". Setelah dikonfirmasi (atau lewat batas waktu Shopee), pesanan menjadi Selesai.',
  },
  'status.IN_CANCEL': {
    title: 'Minta Batal',
    body: 'Pembeli meminta pesanan dibatalkan. Kamu harus menyetujui atau menolaknya lewat menu Aksi.',
    hint: 'Kalau tidak dijawab sampai batas waktu, Shopee menyetujuinya otomatis. Jangan kirim paketnya sebelum ada jawaban.',
  },
  'status.CANCELLED': {
    title: 'Dibatalkan',
    body: 'Pesanan batal — oleh pembeli, penjual, atau otomatis oleh Shopee. Tidak perlu dikirim.',
    hint: 'Kalau Stok Otomatis menyala, stok master yang sudah terpotong kembali sendiri.',
  },
  'status.COMPLETED': {
    title: 'Selesai',
    body: 'Pesanan sudah diterima pembeli dan selesai. Tidak ada tindakan lagi.',
  },

  // ── Status paket (fulfillment Shopee) ─────────────────────────────────────
  'logistics.LOGISTICS_NOT_START': {
    title: 'Belum siap',
    body: 'Paket sudah tercatat tetapi belum siap diproses (misalnya pesanan belum dibayar). Pengirimannya belum bisa diatur.',
  },
  'logistics.LOGISTICS_READY': {
    title: 'Siap diatur',
    body: 'Shopee sudah mengizinkan pengiriman diatur. Hanya paket dengan status ini yang bisa diproses lewat Kirim Massal.',
  },
  'logistics.LOGISTICS_REQUEST_CREATED': {
    title: 'Pengiriman diatur',
    body: 'Pengiriman sudah diatur dan menunggu kurir. Resi masih bisa dicetak selama paket belum diserahkan.',
  },
  'logistics.LOGISTICS_PICKUP_DONE': {
    title: 'Sudah dijemput',
    body: 'Paket sudah diserahkan ke kurir. Resi tidak bisa dicetak lagi.',
  },
  'logistics.LOGISTICS_PICKUP_RETRY': {
    title: 'Pickup gagal, perlu ulang',
    body: 'Kurir gagal menjemput dan menunggu jadwal pickup baru. Jadwalkan ulang; resi masih bisa dicetak.',
  },
  'logistics.LOGISTICS_PICKUP_FAILED': {
    title: 'Pickup gagal',
    body: 'Kurir membatalkan karena paket tidak berhasil dijemput atau tidak bisa dikirim. Pesanannya biasanya ikut batal.',
  },
  'logistics.LOGISTICS_DELIVERY_DONE': {
    title: 'Terkirim',
    body: 'Paket sudah sampai ke pembeli.',
  },
  'logistics.LOGISTICS_DELIVERY_FAILED': {
    title: 'Gagal kirim',
    body: 'Paket tidak berhasil sampai ke pembeli, pengiriman dibatalkan.',
  },
  'logistics.LOGISTICS_INVALID': {
    title: 'Dibatalkan',
    body: 'Paket dibatalkan sebelum pengirimannya sempat diatur.',
  },
  'logistics.LOGISTICS_REQUEST_CANCELED': {
    title: 'Pengiriman dibatalkan',
    body: 'Pengiriman yang sudah diatur dibatalkan.',
  },
  'logistics.LOGISTICS_LOST': {
    title: 'Paket hilang',
    body: 'Kurir kehilangan paket, pesanan dibatalkan.',
  },
  'logistics.LOGISTICS_PENDING_ARRANGE': {
    title: 'Menunggu diatur',
    body: 'Logistik menunggu pengaturan dari penjual.',
  },
  'logistics.LOGISTICS_COD_REJECTED': {
    title: 'COD ditolak',
    body: 'Pesanan bayar-di-tempat (COD) ditolak, jadi tidak dikirim.',
  },

  // ── Pesanan: tab ──────────────────────────────────────────────────────────
  'tab.all': {
    title: 'Semua',
    body: 'Semua pesanan pada rentang tanggal dan filter yang dipilih, apa pun statusnya — termasuk yang Dibatalkan dan Selesai.',
  },
  'tab.unpaid': {
    title: 'Belum Bayar',
    body: 'Pesanan yang sudah dibuat pembeli tetapi belum dibayar. Belum perlu diapa-apakan.',
  },
  'tab.toShip': {
    title: 'Perlu Dikirim',
    body: 'Semua pesanan yang sudah dibayar dan belum diserahkan ke kurir: yang pengirimannya belum diatur, yang pickup-nya gagal, dan yang sudah diatur tetapi belum dijemput.',
    hint: 'Angka di tiap tab mengikuti filter lain (toko, tanggal, kurir), dan dihitung dengan cara yang sama seperti Seller Centre.',
  },
  'tab.shipped': {
    title: 'Dikirim',
    body: 'Pesanan yang paketnya sudah dipegang kurir dan sedang dalam perjalanan.',
  },
  'subtab.group': {
    title: 'Dua tahap dalam Perlu Dikirim',
    items: [
      { term: 'Semua', text: 'Semua pesanan di tab Perlu Dikirim.' },
      { term: 'Perlu Diproses', text: 'Pengiriman belum diatur (Siap Kirim) atau perlu diatur ulang (Pickup Gagal). Ini pekerjaan "Kirim Massal".' },
      { term: 'Telah Diproses', text: 'Pengiriman sudah diatur. Tinggal mencetak resi dan menyerahkan paket ke kurir.' },
    ],
  },

  // ── Pesanan: filter ───────────────────────────────────────────────────────
  'filter.search': {
    title: 'Cari',
    body: 'Mencari berdasarkan nomor pesanan (Order ID) atau nama pembeli. Nomor resi dan nama produk tidak ikut dicari.',
  },
  'filter.platform': {
    title: 'Platform',
    body: 'Marketplace asal pesanan: Shopee atau TikTok Shop.',
  },
  'filter.store': {
    title: 'Toko',
    body: 'Batasi daftar ke satu toko. Kamu hanya melihat toko yang aksesnya diberikan admin.',
  },
  'filter.status': {
    title: 'Status pesanan',
    body: 'Saring ke satu status saja. Pilihannya mengikuti tab yang sedang terbuka supaya tidak ada pilihan yang pasti kosong.',
    hint: 'Untuk melihat Dibatalkan atau Selesai, buka tab Semua lalu pilih di sini.',
  },
  'filter.print': {
    title: 'Status cetak',
    body: 'Apakah resi pesanan sudah pernah dicetak dari OrderPro. Penanda ini hanya diketahui OrderPro — Shopee tidak tahu — jadi tidak akan ada padanannya di Seller Centre.',
  },
  'filter.sort': {
    title: 'Urutkan',
    items: [
      { term: 'Terbaru', text: 'Pesanan yang paling baru dibuat ada di atas.' },
      { term: 'Batas kirim terdekat', text: 'Pesanan yang deadline-nya paling mepet ada di atas. Yang belum punya batas kirim ditaruh paling bawah.' },
    ],
  },
  'filter.courier': {
    title: 'Kurir',
    body: 'Jasa kirim yang dipilih pembeli (SPX, J&T, JNE, dan seterusnya). Daftarnya mengikuti toko dan platform yang sedang dipilih.',
  },
  'filter.dateFrom': {
    title: 'Dari tanggal',
    body: 'Awal rentang tanggal pesanan dibuat (bukan tanggal kirim). Bawaannya hari ini — ubah untuk melihat hari lain.',
  },
  'filter.dateTo': {
    title: 'Sampai tanggal',
    body: 'Akhir rentang tanggal pesanan dibuat. Isi sama dengan "Dari tanggal" untuk satu hari saja.',
  },
  'filter.perPage': {
    title: 'Jumlah per halaman',
    body: 'Berapa baris dimuat sekaligus. Makin banyak, makin jarang pindah halaman tetapi makin lama dimuat.',
  },

  // ── Pesanan: kolom & penanda ──────────────────────────────────────────────
  'col.orderId': {
    title: 'Order ID',
    body: 'Nomor pesanan dari marketplace. "pkg …" di bawahnya adalah nomor paket: satu pesanan bisa dipecah menjadi beberapa paket, dan tiap paket punya resi sendiri.',
  },
  'col.products': {
    title: 'Produk',
    body: 'Barang yang dipesan; "2x" artinya jumlahnya. Dua produk pertama ditampilkan, sisanya diringkas jadi "+N produk lain".',
  },
  'col.courier': {
    title: 'Kurir & nomor resi',
    body: 'Jasa kirim pilihan pembeli, dan di bawahnya nomor resi (kode untuk melacak paket). Nomor resi baru ada setelah pengiriman diatur dan kurir menerbitkannya — sebelum itu kosong.',
  },
  'col.status': {
    title: 'Status pesanan',
    body: 'Tahap pesanan menurut marketplace. Teks kecil di bawah lencananya (kalau ada) adalah status paket: posisi pengiriman fisiknya.',
  },
  'col.deadline': {
    title: 'Batas Kirim',
    body: 'Batas waktu dari Shopee untuk menyerahkan paket ke kurir. Pesanan yang melewatinya berisiko dibatalkan otomatis.',
    items: [
      { term: 'Merah', text: 'Sudah lewat.' },
      { term: 'Oranye', text: 'Jatuh tempo hari ini.' },
      { term: 'Kuning', text: 'Besok.' },
      { term: 'Abu-abu', text: 'Masih beberapa hari lagi.' },
      { term: '—', text: 'Shopee belum mengirim batasnya. Bukan berarti aman.' },
    ],
  },
  'col.actions': {
    title: 'Aksi',
    body: 'Menu tindakan untuk satu pesanan: sinkron, atur pengiriman, cetak resi, lacak, pecah paket, batalkan, dan lainnya. Isinya menyesuaikan status pesanan.',
  },
  'select.all': {
    title: 'Pilih semua',
    items: [
      { term: 'Belum', text: 'Mencentang semua pesanan di halaman ini yang resinya belum dicetak.' },
      { term: 'Sudah', text: 'Mencentang semua yang sudah pernah dicetak — dipakai untuk cetak ulang.' },
    ],
    hint: 'Dibuat terpisah supaya resi kemarin tidak ikut tercetak lagi tanpa sengaja. Pesanan yang kotaknya abu-abu belum bisa dipilih; arahkan atau tekan kotaknya untuk tahu alasannya.',
  },
  'print.badge': {
    title: 'Dicetak',
    body: 'Resi pesanan ini sudah pernah dicetak dari OrderPro.',
    items: [
      { term: 'Dicetak 2×', text: 'Sudah dicetak lagi. Masih ada label lama yang beredar — buang sebelum menempel yang baru.' },
      { term: 'cadangan', text: 'Labelnya buatan aplikasi, bukan resi resmi Shopee. Kurir bisa menolaknya.' },
    ],
  },

  // ── Pesanan: banner & tombol ──────────────────────────────────────────────
  'sync.lastSynced': {
    title: 'Data terakhir disinkronkan',
    body: 'OrderPro menarik pesanan dari Shopee otomatis tiap 15 menit. Waktu ini adalah sync paling lama di antara semua toko, jadi toko yang paling ketinggalan yang menentukan.',
    hint: 'Kalau lebih dari 30 menit, ada yang macet. Tekan Sync Pesanan untuk menarik sekarang.',
  },
  'check.shopee': {
    title: 'Cocok dengan Shopee',
    body: 'Setiap selesai sync, OrderPro membandingkan jumlah pesanannya dengan yang dilaporkan Shopee, per toko dan per status. "Cocok" berarti tidak ada pesanan yang tertinggal.',
    hint: 'Tekan lencananya untuk melihat rinciannya per toko.',
  },
  'urgency.banner': {
    title: 'Lewat batas kirim',
    body: 'Jumlah pesanan yang batas kirimnya sudah lewat, dan yang jatuh tempo hari ini sebelum tengah malam. Dihitung di semua tab, supaya tetap terlihat walau kamu sedang membuka tab lain.',
    hint: '"Urutkan yang paling mepet" menaruh yang paling genting di paling atas.',
  },
  'awaiting.tracking': {
    title: 'Belum punya nomor resi',
    body: 'Pengiriman sudah diatur tetapi kurir belum menerbitkan nomor resinya, jadi belum bisa dicetak. Biasanya terbit beberapa menit kemudian.',
    hint: '"Ambil semua nomor resi" menanyakannya ke kurir sekarang.',
  },
  'btn.syncOrders': {
    title: 'Sync Pesanan',
    body: 'Menarik pesanan terbaru dari semua toko dan memperbarui status pesanan lama, sekarang juga, tanpa menunggu sync otomatis tiap 15 menit.',
    hint: 'Tombol berhenti berputar setelah semua toko melapor (paling lama sekitar 90 detik).',
  },
  'btn.syncSelected': {
    title: 'Sinkron',
    body: 'Membaca ulang pesanan yang dicentang langsung dari Shopee. Angka di dalam kurung adalah jumlah pesanannya.',
    hint: 'Lakukan ini sebelum Kirim Massal atau Cetak Resi, supaya status dan nomor resinya yang terbaru.',
  },
  'btn.massShip': {
    title: 'Kirim Massal',
    body: 'Mengatur pengiriman semua pesanan terpilih sekaligus ke Shopee. Pesanan dikelompokkan per kurir, dan tiap kurir kamu pilih: dijemput kurir atau diantar ke counter. Hanya pesanan berstatus "Siap diatur" yang ikut.',
    hint: 'Pos dan JNE tidak menjemput — pilih "Ke counter".',
  },
  'btn.massRetry': {
    title: 'Jadwalkan Ulang Pickup',
    body: 'Untuk pesanan Pickup Gagal: meminta Shopee menjemput lagi di alamat dan jam yang kamu pilih. Beda dengan Kirim Massal, yang hanya untuk pesanan yang belum pernah diatur.',
  },
  'btn.printAwb': {
    title: 'Cetak Resi Shopee',
    body: 'Mengunduh label resi resmi dari Shopee untuk pesanan terpilih. Inilah label yang dipindai kurir. Pesanan lalu ditandai Dicetak.',
    hint: 'Maksimal 300 paket sekali unduh. Resi tidak bisa diunduh lagi setelah paket dijemput kurir.',
  },
  'btn.printFallback': {
    title: 'Resi Cadangan',
    body: 'Label yang digambar sendiri oleh OrderPro, bukan dari Shopee. Pakai hanya kalau resi resmi gagal diunduh.',
    hint: 'Kurir bisa menolak label ini karena tidak memuat kode pemilahan Shopee.',
  },
  'btn.printTiktok': {
    title: 'Cetak Resi TikTok',
    body: 'Mencetak label untuk pesanan TikTok Shop yang dipilih.',
  },
  'btn.refreshTrackingAll': {
    title: 'Ambil semua nomor resi',
    body: 'Menanyakan ke kurir nomor resi untuk semua pesanan yang masih kosong, paling mendesak dulu. Satu klik memproses sampai 100 pesanan.',
    hint: 'Kalau masih ada sisa, klik sekali lagi.',
  },

  // ── Pesanan: dialog Aksi ──────────────────────────────────────────────────
  'ship.mode': {
    title: 'Mode pengiriman',
    items: [
      { term: 'Dijemput kurir (pickup)', text: 'Kurir datang ke alamat toko pada slot waktu yang kamu pilih. Butuh alamat dan slot waktu.' },
      { term: 'Antar sendiri (dropoff)', text: 'Kamu mengantar paket ke counter atau agen kurir. Tidak butuh slot waktu.' },
      { term: 'Resi sendiri (non-integrated)', text: 'Untuk kurir di luar sistem Shopee: kamu mengisi nomor resinya sendiri.' },
    ],
    hint: 'Pos dan JNE tidak menjemput — pilih antar sendiri.',
  },
  'ship.address': {
    title: 'Alamat penjemputan',
    body: 'Alamat toko tempat kurir akan menjemput paket, dipilih dari alamat yang terdaftar di Shopee.',
  },
  'ship.slot': {
    title: 'Slot waktu',
    body: 'Tanggal dan jam kurir datang menjemput. Tiap kurir punya jadwalnya sendiri, jadi pilihannya berubah mengikuti alamat yang dipilih.',
  },
  'ship.tracking': {
    title: 'Nomor resi',
    body: 'Kode pelacakan dari kurir. Diisi sendiri hanya untuk mode "Resi sendiri"; di mode lain nomor resi terbit otomatis dari kurir.',
  },
  'cancel.reason': {
    title: 'Alasan pembatalan',
    body: 'Alasan yang dikirim ke Shopee bersama pembatalan. Pilih yang benar-benar terjadi.',
    hint: 'Pembatalan dari penjual tidak bisa diurungkan.',
  },
  'split.count': {
    title: 'Jumlah paket',
    body: 'Berapa paket yang dibuat dari pesanan ini. Tiap paket mendapat resi sendiri, dan barangnya dibagi ke paket-paket itu di daftar di bawahnya.',
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  'dash.toShip': {
    title: 'Siap Kirim',
    body: 'Pesanan yang sudah dibayar dan menunggu pengirimannya diatur (status Siap Kirim).',
    hint: 'Bukan sama dengan tab "Perlu Dikirim" di halaman Pesanan — tab itu juga menghitung yang sudah diatur dan yang pickup-nya gagal.',
  },
  'dash.awaitingPickup': {
    title: 'Menunggu Pickup',
    body: 'Pengiriman sudah diatur (status Sudah Diatur), tinggal menunggu kurir menjemput atau paket diantar ke counter.',
  },
  'dash.shipped': {
    title: 'Dikirim',
    body: 'Paket sudah dipegang kurir, termasuk yang sudah sampai dan menunggu konfirmasi pembeli.',
  },
  'dash.needsAttention': {
    title: 'Perlu Tindakan',
    body: 'Pesanan yang butuh keputusan manusia: pickup yang gagal (harus dijadwalkan ulang) dan pembeli yang meminta batal (harus disetujui atau ditolak).',
    hint: 'Kalau permintaan batal tidak dijawab, Shopee menyetujuinya otomatis.',
  },
  'dash.cards': {
    title: 'Empat angka di atas',
    body: 'Jumlah paket saat ini per tahap pekerjaan, di semua toko yang boleh kamu lihat, tanpa dibatasi tanggal. Berbeda dengan blok Statistik di bawahnya, yang mengikuti periode.',
  },
  'stats.basis': {
    title: 'Status Pesanan (dasar hitung)',
    body: 'Pilih pesanan mana yang dihitung di blok Statistik — sama seperti pilihan "Status Pesanan" di Data Center Shopee. Pilihan yang berbeda memberi angka yang berbeda, dan itu wajar.',
    items: [
      { term: 'Pesanan Dibuat', text: 'Semua pesanan yang masuk di periode ini, apa pun statusnya.' },
      { term: 'Pesanan Siap Dikirim', text: 'Yang sudah dibayar: tanpa Belum Bayar dan tanpa Dibatalkan.' },
      { term: 'Pesanan Selesai', text: 'Hanya pesanan yang sudah selesai.' },
    ],
  },
  'stats.dateRange': {
    title: 'Periode',
    body: 'Tanggal pesanan dibuat, dari tanggal awal sampai tanggal akhir (keduanya ikut dihitung).',
  },
  'stats.untilTime': {
    title: 'Sampai jam',
    body: 'Batas jam pada tanggal akhir. Kosong berarti sampai akhir hari. Berguna untuk membandingkan dengan Seller Centre di jam tertentu.',
  },
  'stats.totalValue': {
    title: 'Nilai Total Pesanan',
    body: 'Jumlah subtotal barang dari semua pesanan yang dihitung menurut dasar hitung yang dipilih.',
  },
  'stats.completedValue': {
    title: 'Nilai Pesanan Selesai',
    body: 'Jumlah subtotal barang dari pesanan yang sudah selesai saja.',
  },
  'stats.cancelledValue': {
    title: 'Nilai Pesanan Dibatalkan',
    body: 'Jumlah subtotal barang dari pesanan yang dibatalkan — penjualan yang tidak jadi.',
  },
  'stats.averageValue': {
    title: 'Rata-rata per Pesanan',
    body: 'Nilai total dibagi jumlah pesanan.',
  },
  'stats.orderCount': {
    title: 'Jumlah Pesanan',
    body: 'Banyaknya pesanan menurut dasar hitung yang dipilih. Dihitung per pesanan, bukan per paket — satu pesanan yang dipecah jadi dua paket tetap dihitung satu.',
  },
  'stats.readyToShip': {
    title: 'Pesanan Siap Dikirim',
    body: 'Pesanan berstatus Siap Kirim: sudah dibayar, pengirimannya belum diatur.',
    hint: 'Jangan tertukar dengan pilihan dasar hitung bernama sama di atas, yang artinya "semua yang sudah dibayar".',
  },
  'stats.shipped': {
    title: 'Pesanan Dikirim',
    body: 'Pesanan yang paketnya sudah dipegang kurir, termasuk yang menunggu konfirmasi pembeli.',
  },
  'stats.cancelled': {
    title: 'Pesanan Dibatalkan',
    body: 'Pesanan yang dibatalkan, oleh pembeli, penjual, atau otomatis oleh Shopee.',
  },
  'stats.breakdown': {
    title: 'Rincian',
    body: 'Jumlah pesanan tadi dipecah per status sampai habis, supaya terlihat ke mana perginya tiap pesanan. "Dasar lain" menunjukkan angka kalau dasar hitungnya diganti — berguna untuk mencocokkan dengan Seller Centre.',
  },
  'dash.stores': {
    title: 'Toko Aktif',
    body: 'Toko yang tersambung, jumlah pesanannya, dan kondisi koneksinya. "token s/d" adalah jam akses ke toko itu perlu diperbarui; OrderPro memperbaruinya sendiri.',
  },

  // ── Status toko ───────────────────────────────────────────────────────────
  'storeStatus.ACTIVE': {
    title: 'Terhubung',
    body: 'Toko tersambung dan sync terakhirnya berhasil.',
  },
  'storeStatus.TOKEN_EXPIRED': {
    title: 'Token kedaluwarsa',
    body: 'Izin akses ke toko ini sudah habis masa berlakunya. Biasanya cukup "Koneksikan Ulang" (ikon rantai) untuk memperbaruinya.',
  },
  'storeStatus.NEEDS_RECONNECT': {
    title: 'Perlu otorisasi ulang',
    body: 'Shopee meminta pemilik toko mengotorisasi ulang aplikasi ini. Selama belum, pesanan toko ini tidak bisa ditarik.',
    hint: 'Satu-satunya cara memperbaikinya: klik ikon petir dan login lagi ke toko tersebut.',
  },
  'storeStatus.SYNC_PARTIAL': {
    title: 'Sync sebagian',
    body: 'Sync berjalan tetapi sebagian status gagal diambil dari Shopee. Pesanan di status itu belum tentu terbarui — datanya diam-diam bisa basi.',
    hint: 'Sync berikutnya akan mencoba lagi.',
  },
  'storeStatus.SYNC_ERROR': {
    title: 'Sync gagal',
    body: 'Sync terakhir toko ini gagal total, jadi pesanan barunya tidak masuk. Alasan dari Shopee tertulis di bawah nama toko.',
  },
  'storeStatus.ERROR': {
    title: 'Error',
    body: 'Terjadi kesalahan pada koneksi toko ini. Coba "Koneksikan Ulang"; kalau berulang, kirim hasil dari Pengaturan → Cek Sistem ke developer.',
  },
  'store.connectShopee': {
    title: 'Login & Hubungkan Toko Shopee',
    body: 'Membuka halaman otorisasi Shopee. Kamu login dengan akun penjual dan memilih toko yang diizinkan; setelah itu tokonya tersambung dan pesanannya mulai ditarik.',
    hint: 'Shopee meminta toko dipilih sendiri, jadi ulangi untuk tiap toko. Tombol ini juga dipakai untuk memulihkan toko yang "Perlu otorisasi ulang".',
  },
  'store.connectTiktok': {
    title: 'Login & Hubungkan TikTok Shop',
    body: 'Menghubungkan toko TikTok Shop. Integrasi TikTok belum berfungsi: klien API-nya belum cocok dengan TikTok Shop dan belum bisa diuji tanpa kredensial dari TikTok.',
    hint: 'Jangan berharap pesanan TikTok masuk dulu.',
  },
  'store.authCheck': {
    title: 'Toko yang mengotorisasi vs yang tersambung',
    body: 'Membandingkan daftar toko yang sudah memberi izin ke aplikasi ini di Shopee dengan toko yang tersambung di OrderPro. Toko yang sudah memberi izin tetapi belum tersambung tidak pernah mengirim pesanan, dan tidak ada layar lain yang menandai kekurangannya.',
    items: [
      { term: 'Belum tersambung', text: 'Sudah mengotorisasi di Shopee, tetapi belum ditambahkan di sini. Tombol "Hubungkan toko berikutnya" menyambungkannya satu per satu.' },
      { term: 'Masih aktif tapi tidak terdaftar di Shopee', text: 'Tersambung di sini, tetapi izinnya di Shopee sudah dicabut, jadi pesanannya sudah berhenti masuk.' },
    ],
  },
  'store.statusGroup': {
    title: 'Status koneksi toko',
    items: [
      { term: 'Terhubung', text: 'Tersambung dan sync terakhir berhasil.' },
      { term: 'Token kedaluwarsa', text: 'Izin akses habis masa berlakunya. Biasanya cukup Koneksikan Ulang.' },
      { term: 'Perlu otorisasi ulang', text: 'Shopee meminta toko mengotorisasi ulang; hanya login ulang yang memperbaikinya.' },
      { term: 'Sync sebagian', text: 'Sebagian status gagal diambil, jadi datanya bisa basi.' },
      { term: 'Sync gagal', text: 'Sync terakhir gagal total; pesanan baru tidak masuk.' },
      { term: 'Error', text: 'Ada kesalahan pada koneksi toko.' },
    ],
    hint: 'Tekan "?" di sebelah lencana tiap toko untuk penjelasan lengkapnya.',
  },
  'store.shopId': {
    title: 'Shop ID',
    body: 'Nomor identitas toko di marketplace. Dipakai untuk mencocokkan toko yang diotorisasi di Shopee dengan yang tersambung di sini.',
  },
  'store.orderCount': {
    title: 'Jumlah Pesanan',
    body: 'Banyaknya pesanan toko ini yang tersimpan di OrderPro (bukan seluruh riwayat Shopee).',
  },
  'store.lastSync': {
    title: 'Sync Terakhir',
    body: 'Kapan OrderPro terakhir berhasil menarik pesanan dari toko ini.',
  },
  'store.actions': {
    title: 'Aksi',
    body: 'Perbaikan koneksi, hanya muncul kalau perlu.',
    items: [
      { term: 'Ikon petir', text: 'Otorisasi ulang lewat login toko (untuk "Perlu otorisasi ulang").' },
      { term: 'Ikon rantai', text: 'Koneksikan ulang: memperbarui izin akses toko yang kedaluwarsa atau error.' },
    ],
  },

  // ── Produk ────────────────────────────────────────────────────────────────
  'product.concepts': {
    title: 'Listing, Master, dan Pemetaan',
    items: [
      { term: 'Listing', text: 'Satu varian produk di satu toko, persis seperti satu baris di Shopee. Satu produk dengan 5 varian berarti 5 listing.' },
      { term: 'Master Produk (Master SKU)', text: 'Satu kode SKU internal untuk satu varian barang fisik. Stok dipegang di master, lalu dikirim ke semua listing yang terikat.' },
      { term: 'Pemetaan', text: 'Mengikat sebuah listing ke Master SKU-nya. Barang yang sama di banyak toko dipetakan ke master yang sama, sehingga stoknya diatur sekali saja.' },
    ],
    hint: 'Listing yang belum dipetakan tidak ikut diatur stoknya dari OrderPro.',
  },
  'product.total': {
    title: 'Total Listing',
    body: 'Banyaknya listing (varian) dari semua toko yang sudah ditarik ke OrderPro.',
  },
  'product.mapped': {
    title: 'Sudah Punya Master',
    body: 'Listing yang sudah diikat ke Master SKU. Stok listing ini bisa diatur dari Daftar Stok.',
  },
  'product.unmapped': {
    title: 'Belum Dipetakan',
    body: 'Listing yang belum diikat ke Master SKU mana pun. Stoknya tidak ikut diatur dan tidak ikut berkurang otomatis dari pesanan.',
    hint: 'Pilih listingnya lalu "Jadikan Master" atau "Petakan ke Master".',
  },
  'product.masters': {
    title: 'Master Produk',
    body: 'Banyaknya Master SKU yang sudah dibuat.',
  },
  'btn.syncStock': {
    title: 'Sinkron Stok',
    body: 'Membaca ulang angka stok semua listing dari Shopee dan menyimpannya di OrderPro, supaya kolom Stok di bawah sesuai kenyataan. Hanya membaca — tidak mengubah apa pun di Shopee.',
    hint: 'Stok yang tidak terbaca dibiarkan seperti semula, tidak ditulis nol.',
  },
  'btn.pullCatalog': {
    title: 'Tarik Katalog',
    body: 'Mengambil daftar produk dari Shopee ke OrderPro. Pakai saat toko menambah produk baru. Hanya membaca — tidak ada perubahan yang dikirim ke marketplace.',
    hint: 'Lebih berat dari Sinkron Stok, jadi jarang diperlukan.',
  },
  'btn.automap': {
    title: 'Petakan Otomatis dari SKU',
    body: 'Mengikat semua listing yang belum dipetakan ke master yang SKU-nya sama persis. Tidak pernah mengubah listing yang sudah kamu petakan sendiri.',
    hint: 'Kamu diminta konfirmasi dulu dengan jumlah listing yang akan terpengaruh.',
  },
  'btn.importMaster': {
    title: 'Import Master',
    body: 'Membuat banyak master sekaligus lewat file Excel, tanpa membuka Jadikan Master satu per satu. Unduh template berisi semua listing yang belum punya master, rapikan Master SKU-nya di Excel, lalu unggah lagi.',
    hint: 'Tidak ada yang tersimpan sebelum kamu membaca pratinjau dan menekan Simpan.',
  },
  'import.template': {
    title: 'Kolom template',
    items: [
      { term: 'Master SKU', text: 'Sudah diisi dari SKU Shopee. Baris dengan Master SKU sama jadi satu master, walaupun dari toko berbeda. Kosongkan untuk melewati baris itu.' },
      { term: 'Nama Master Produk', text: 'Baris dengan nama sama dikumpulkan di bawah satu induk.' },
      { term: 'Stok Awal', text: 'Kosongkan untuk memakai stok Shopee. Kalau satu Master SKU ada di beberapa toko dengan stok berbeda, yang dipakai yang paling kecil.' },
      { term: 'ID (jangan diubah)', text: 'Kunci untuk mencocokkan baris ke listing. Jangan diubah atau dihapus.' },
    ],
    hint: 'Simpan tetap sebagai .xlsx. File CSV tidak bisa dibaca.',
  },
  'import.preview': {
    title: 'Membaca pratinjau',
    items: [
      { term: 'Master baru', text: 'Master SKU yang belum ada dan akan dibuat.' },
      { term: 'Digabung', text: 'Listing yang Master SKU-nya sudah ada di OrderPro. Listing itu ikut ke master tersebut, dan stok master-nya tidak diubah.' },
      { term: 'Stok beda antartoko', text: 'Satu Master SKU dipakai beberapa toko yang stoknya tidak sama. Yang dipakai yang paling kecil, kecuali kamu mengisi Stok Awal.' },
      { term: 'Dilewati', text: 'Baris yang Master SKU-nya kosong atau listingnya sudah punya master.' },
      { term: 'Dikirim ke Shopee', text: 'Master yang stoknya berbeda dengan salah satu listingnya. Setelah disimpan, angka master dikirim ke listing itu.' },
    ],
    hint: 'Kalau ada baris merah, betulkan di Excel lalu unggah lagi. Tombol Simpan baru aktif setelah tidak ada yang salah.',
  },
  'btn.makeMaster': {
    title: 'Jadikan Master',
    body: 'Membuat Master SKU baru dari listing yang dicentang, satu SKU untuk tiap varian. Stok awal master diambil dari stok listing, dan SKU-nya bisa kamu ubah dulu.',
  },
  'btn.mapExisting': {
    title: 'Petakan ke Master',
    body: 'Mengikat listing yang dicentang ke Master SKU yang sudah ada, misalnya barang yang sama di toko lain.',
  },
  'btn.unmap': {
    title: 'Lepas Pemetaan',
    body: 'Melepas ikatan listing dari masternya. Master dan stoknya tidak terhapus; listing itu hanya berhenti ikut diatur.',
  },
  'btn.copyProduct': {
    title: 'Salin Produk',
    body: 'Membuat draf produk baru di toko lain dari produk ini, lalu kamu poles dan terbitkan. Hanya bisa untuk varian dari satu produk yang sama.',
  },
  'tab.productsActive': {
    title: 'Aktif',
    body: 'Daftar listing dari semua toko yang sudah ditarik dari Shopee.',
  },
  'tab.productsDrafts': {
    title: 'Draf',
    body: 'Produk yang sedang disiapkan untuk diterbitkan di toko lain (hasil Salin Produk). Angka di kurung adalah draf yang belum terbit.',
  },
  'filter.productSearch': {
    title: 'Cari',
    body: 'Mencari di nama produk, SKU listing, dan ID produk Shopee. Tekan Enter atau tombol cari.',
  },
  'filter.masterSearch': {
    title: 'Cari',
    body: 'Mencari di SKU master dan nama master. Tekan Enter atau tombol cari.',
  },
  'filter.mapped': {
    title: 'Pemetaan',
    body: 'Saring listing berdasarkan sudah atau belum diikat ke Master SKU.',
  },
  'filter.listingStatus': {
    title: 'Status listing',
    body: 'Keadaan listing di Shopee.',
    items: [
      { term: 'Aktif', text: 'Tayang dan bisa dibeli.' },
      { term: 'Diarsipkan', text: 'Disembunyikan penjual, tidak tayang.' },
      { term: 'Diblokir', text: 'Dilarang tayang oleh Shopee karena pelanggaran.' },
      { term: 'Dihapus', text: 'Sudah dihapus.' },
    ],
  },
  'listingStatus.NORMAL': {
    title: 'Aktif',
    body: 'Listing tayang di Shopee dan bisa dibeli.',
  },
  'listingStatus.UNLIST': {
    title: 'Diarsipkan',
    body: 'Disembunyikan oleh penjual, jadi tidak tayang dan tidak bisa dibeli.',
  },
  'listingStatus.BANNED': {
    title: 'Diblokir',
    body: 'Shopee melarang listing ini tayang karena pelanggaran. Biasanya perlu ditindaklanjuti di Seller Centre.',
  },
  'listingStatus.DELETED': {
    title: 'Dihapus',
    body: 'Listing sudah dihapus dari Shopee.',
  },
  'col.listing.product': {
    title: 'Produk',
    body: 'Nama produk dan varian yang bersangkutan.',
  },
  'col.listing.sku': {
    title: 'SKU',
    body: 'Kode SKU yang kamu isi di listing Shopee. Kalau sama persis dengan SKU sebuah master, listing bisa dipetakan otomatis.',
  },
  'col.listing.master': {
    title: 'Master',
    body: 'Master SKU yang terikat dengan listing ini. "belum" berarti listing belum diikat ke master mana pun, sehingga stoknya tidak diatur dari OrderPro.',
  },
  'col.listing.status': {
    title: 'Status listing',
    body: 'Keadaan listing di Shopee: Aktif, Diarsipkan, Diblokir, atau Dihapus.',
  },
  'col.listing.price': {
    title: 'Harga',
    body: 'Harga jual listing di Shopee, dalam rupiah.',
  },
  'col.listing.stock': {
    title: 'Stok',
    body: 'Stok listing di Shopee menurut penyegaran terakhir. Tanda "?" berarti Shopee tidak menjawab — itu bukan nol.',
    hint: 'Angka ini bukan stok master. Stok master ada di Daftar Stok.',
  },

  'masterForm.name': {
    title: 'Nama Master Produk',
    body: 'Nama untuk produk induk yang menaungi varian-varian di bawahnya. Hanya dipakai di OrderPro; tidak mengubah nama produk di Shopee.',
  },
  'masterForm.sku': {
    title: 'SKU Produk dan Master SKU',
    items: [
      { term: 'SKU Produk', text: 'Kode SKU yang sudah ada di listing Shopee. Hanya dibaca, tidak bisa diubah di sini.' },
      { term: 'Master SKU', text: 'Kode internal untuk varian ini. Terisi otomatis dari SKU Produk dan boleh kamu ubah. Satu varian satu Master SKU.' },
    ],
    hint: 'Kalau Master SKU-nya sudah ada, listing ini digabung ke master itu dan stok master-nya tidak diubah.',
  },
  'masterForm.shared': {
    title: 'Stok dipakai bersama',
    body: 'Varian yang SKU-nya sama diikat ke satu master, jadi stoknya satu angka dan diubah sekali. Dipakai untuk paket yang memakai barang yang sama, misalnya jaket Anak dan jaket + Jogger yang diambil dari tumpukan jaket yang sama.',
    items: [
      { term: 'Stok awal', text: 'Diambil dari yang paling sedikit di antara varian itu, supaya tidak menjual lebih dari yang ada. Bisa dinaikkan lewat Edit Stok.' },
      { term: 'Setelah itu', text: 'Setiap kali stok master berubah, semua varian yang terikat ikut dikirim angka yang sama. Pesanan dari salah satunya mengurangi stok yang sama.' },
      { term: 'Yang tidak dihitung', text: 'Barang pelengkap paket (misalnya celana Jogger) tidak punya stok sendiri di sini. Kalau pelengkapnya bisa habis lebih dulu, cek stoknya manual.' },
    ],
    hint: 'Biarkan mati kalau SKU kembar itu sebenarnya kesalahan, misalnya semua warna tidak sengaja memakai SKU produk induk.',
  },
  'masterForm.stock': {
    title: 'Stok Awal',
    body: 'Stok master saat pertama dibuat, disalin dari stok listing di Shopee. Setelah itu stok dikelola dari Daftar Stok.',
    hint: 'Tanda ⚠ 0 berarti stok listing tidak terbaca dari Shopee, jadi diisi 0. Perbaiki lewat Edit Stok setelah master dibuat.',
  },

  // ── Draf produk ───────────────────────────────────────────────────────────
  'draft.DRAFT': {
    title: 'Draf',
    body: 'Belum tayang di Shopee. Masih bisa diedit dan dihapus.',
  },
  'draft.PUBLISHING': {
    title: 'Sedang Publish',
    body: 'Sedang dikirim ke Shopee. Tunggu sampai selesai; draf ini belum bisa diedit atau dihapus.',
  },
  'draft.FAILED': {
    title: 'Gagal',
    body: 'Shopee menolak draf ini. Tekan lencana atau buka draf untuk membaca alasannya, perbaiki, lalu Publish lagi.',
  },
  'draft.PUBLISHED': {
    title: 'Terbit',
    body: 'Sudah tayang di toko tujuan, dan listing barunya otomatis terikat ke Master SKU.',
  },
  'draft.filterStatus': {
    title: 'Status draf',
    items: [
      { term: 'Belum terbit', text: 'Semua yang belum tayang: Draf, Sedang Publish, dan Gagal.' },
      { term: 'Draf', text: 'Belum diterbitkan, masih bisa diedit.' },
      { term: 'Sedang Publish', text: 'Sedang dikirim ke Shopee.' },
      { term: 'Gagal', text: 'Ditolak Shopee — lihat alasannya, perbaiki, ulangi.' },
      { term: 'Terbit', text: 'Sudah tayang di toko tujuan.' },
      { term: 'Semua', text: 'Termasuk yang sudah terbit.' },
    ],
    hint: 'Filter toko di bagian atas halaman berlaku untuk toko tujuan, bukan toko asal.',
  },
  'draft.columns': {
    title: 'Membaca daftar draf',
    items: [
      { term: 'Lencana oranye', text: 'Toko tujuan: toko tempat draf ini akan diterbitkan.' },
      { term: 'dari …', text: 'Toko asal: produk yang disalin.' },
      { term: 'SKU', text: 'Kode SKU induk produk.' },
      { term: 'Master SKU', text: 'Setelah terbit, listing barunya otomatis terikat ke Master SKU sehingga stoknya ikut dikelola dari OrderPro. Sebelum terbit tampil "—".' },
      { term: 'Harga & stok', text: 'Rentang harga semua varian dan jumlah stok semua varian.' },
      { term: 'Tombol Atur', text: 'Publish Produk (kirim ke Shopee), Edit Produk (ubah sebelum terbit), atau Hapus Draf (membuang draf; produk di Shopee tidak terpengaruh).' },
    ],
  },
  'draftForm.store': {
    title: 'Toko tujuan',
    body: 'Toko tempat produk ini akan diterbitkan. Tidak bisa diubah di draf yang sudah dibuat.',
  },
  'draftForm.name': {
    title: 'Nama Produk',
    body: 'Judul produk di Shopee. Tidak boleh sama persis dengan nama produk asal — Shopee menolaknya — jadi ubah sedikit. Ada batas jumlah karakter; penghitungnya ada di kanan kolom.',
  },
  'draftForm.description': {
    title: 'Deskripsi',
    body: 'Penjelasan produk yang dibaca pembeli. Toko yang belum diizinkan Shopee memakai deskripsi bergambar akan otomatis diterbitkan sebagai teks biasa.',
  },
  'draftForm.category': {
    title: 'Kategori',
    body: 'Letak produk di pohon kategori Shopee. Kategori menentukan atribut apa saja yang wajib diisi. Disamakan dengan produk asal, dan belum bisa diubah di sini.',
  },
  'draftForm.brand': {
    title: 'Merek',
    body: 'Merek produk menurut daftar Shopee; ketik di kolom cari untuk mengganti. Kalau kategori tidak mewajibkan merek, kamu boleh memilih "Tanpa merek (NoBrand)".',
  },
  'draftForm.attributes': {
    title: 'Atribut Produk',
    body: 'Data tambahan yang diminta kategori, misalnya bahan atau model. Yang bertanda * wajib diisi, kalau kosong Shopee menolak produknya.',
  },
  'draftForm.photos': {
    title: 'Foto Produk',
    body: 'Foto yang tampil di halaman produk. Foto pertama jadi foto utama; bintang di tiap foto menjadikannya foto utama. Ada batas minimal dan maksimal jumlah foto.',
  },
  'draftForm.variantPhotos': {
    title: 'Foto Variasi',
    body: 'Foto yang berganti ketika pembeli memilih satu pilihan variasi (misalnya warna). Isi untuk semua pilihan, atau kosongkan semuanya.',
  },
  'draftForm.video': {
    title: 'Video Produk',
    body: 'Video tidak ikut tersalin. Tambahkan lewat Seller Centre setelah produk tayang.',
  },
  'draftForm.sizeChart': {
    title: 'Bagan Ukuran',
    body: 'Tabel ukuran yang tampil di halaman produk (untuk fashion). Wajib di kategori tertentu.',
  },
  'draftForm.parentSku': {
    title: 'SKU Induk',
    body: 'Kode SKU di tingkat produk, bukan per varian. Opsional. Kalau produk punya variasi, kode per varian diisi di kolom SKU pada tabel variasi.',
  },
  'draftForm.price': {
    title: 'Harga',
    body: 'Harga jual di Shopee, dalam rupiah. Harga pembeli bisa lebih rendah kalau ada voucher atau promo.',
  },
  'draftForm.stock': {
    title: 'Stok',
    body: 'Jumlah barang yang tersedia saat produk terbit. Selanjutnya stok dikelola lewat Master SKU di Daftar Stok.',
  },
  'draftForm.variations': {
    title: 'Variasi',
    body: 'Pilihan yang bisa dipilih pembeli, misalnya Warna dan Ukuran. Tiap kombinasi punya harga, stok, dan SKU sendiri, dan menjadi satu listing.',
  },
  'draftForm.weight': {
    title: 'Berat (gram)',
    body: 'Berat paket yang sudah dikemas, dalam gram. Dipakai Shopee untuk menghitung ongkos kirim. Wajib diisi.',
  },
  'draftForm.dimensions': {
    title: 'Ukuran Paket (cm)',
    body: 'Panjang × lebar × tinggi paket. Opsional, tetapi kurir tertentu menghitung ongkir dari ukuran bila lebih besar daripada beratnya.',
  },
  'draftForm.logistics': {
    title: 'Jasa Kirim',
    body: 'Kurir yang boleh dipilih pembeli untuk produk ini. Minimal satu harus dicentang, dan kurirnya harus aktif di toko tujuan.',
  },
  'draftForm.condition': {
    title: 'Kondisi',
    body: 'Baru atau bekas.',
  },
  'draftForm.preorder': {
    title: 'Pre-order',
    body: 'Nyalakan kalau barang perlu waktu lebih lama dari biasanya sebelum dikirim. Kamu mengisi berapa hari, dan Shopee menampilkannya ke pembeli.',
  },

  // ── Daftar Stok ───────────────────────────────────────────────────────────
  'stock.master': {
    title: 'Stok master',
    body: 'Angka acuan stok yang dipegang OrderPro untuk satu varian barang. Setiap kali disimpan, angkanya langsung dikirim ke semua listing Shopee yang terikat dengan master itu.',
  },
  'stock.auto': {
    title: 'Kurangi stok otomatis',
    body: 'Kalau menyala: stok master berkurang sendiri saat pesanan dibayar, lalu angka barunya dikirim ke semua toko. Pesanan yang batal sebelum dikirim mengembalikan stoknya.',
    items: [
      { term: 'Retur', text: 'Tidak otomatis. Cek barang fisiknya, lalu tambah lewat Edit Stok.' },
      { term: 'Mulai dihitung', text: 'Hanya pesanan setelah saklar dinyalakan. Isi stok yang benar dulu (stock opname) sebelum menyalakan.' },
      { term: 'Listing belum dipetakan', text: 'Pesanannya diabaikan karena tidak diketahui masternya.' },
    ],
    hint: 'Hanya admin yang bisa menyalakan atau mematikannya.',
  },
  'col.master.sku': {
    title: 'SKU Master',
    body: 'Kode internal untuk satu varian barang. Kode inilah yang mengikat barang yang sama di banyak toko.',
  },
  'col.master.name': {
    title: 'Nama Produk',
    body: 'Nama master: produk dan variannya.',
  },
  'col.master.listings': {
    title: 'Listing Terikat',
    body: 'Banyaknya listing Shopee yang terikat ke master ini, dan akan ikut berubah stoknya. Tanda ⚠ 0 berarti master belum terikat ke listing mana pun — mengubah stoknya tidak mengubah apa pun di toko.',
  },
  'col.master.stock': {
    title: 'Stok',
    body: 'Stok master, yaitu angka acuannya. Tekan Edit untuk mengubahnya, atau Riwayat untuk melihat siapa mengubah apa dan kapan.',
  },
  'stock.cardLegend': {
    title: 'Membaca kartu stok',
    items: [
      { term: 'Angka besar di kanan', text: 'Stok master: angka acuan yang dipegang OrderPro.' },
      { term: 'Listing', text: 'Banyaknya listing Shopee yang terikat dan akan ikut berubah stoknya. ⚠ 0 berarti master belum terikat ke listing mana pun, jadi mengubah stoknya tidak mengubah apa pun di toko.' },
      { term: 'Di Shopee', text: 'Stok yang saat ini dipegang listing Shopee tersebut. Kalau beda-beda tampil sebagai rentang. Tanda ⚠ berarti beda dengan stok master — biasanya karena ada penjualan sejak penyimpanan terakhir.' },
      { term: 'Edit', text: 'Mengetik angka stok master yang baru. Saat disimpan, langsung dikirim ke semua listing Shopee yang terikat.' },
      { term: 'Riwayat', text: 'Daftar setiap perubahan stok master ini: kapan, berapa, dan penyebabnya.' },
    ],
  },
  'stock.actions': {
    title: 'Aksi',
    items: [
      { term: 'Edit Stok', text: 'Mengetik angka stok master yang baru. Saat disimpan, angkanya langsung dikirim ke semua listing Shopee yang terikat, dan perubahannya tercatat di Riwayat.' },
      { term: 'Riwayat', text: 'Daftar setiap perubahan stok master ini: kapan, berapa, dan penyebabnya.' },
    ],
  },
  'col.master.shopee': {
    title: 'Di Shopee',
    body: 'Stok yang saat ini dipegang listing Shopee yang terikat, menurut penyegaran atau pengiriman terakhir. Kalau listing-nya beda-beda, tampil sebagai rentang (misal 17–20).',
    hint: 'Tanda ⚠ berarti beda dengan stok master — biasanya karena ada penjualan sejak penyimpanan terakhir. Simpan stok untuk mengirim angka master ke Shopee.',
  },
  'stock.history': {
    title: 'Riwayat',
    body: 'Daftar setiap perubahan stok master ini: kapan, berapa, dan penyebabnya.',
    items: [
      { term: 'Pesanan', text: 'Stok berkurang karena pesanan dibayar.' },
      { term: 'Batal', text: 'Stok kembali karena pesanan dibatalkan.' },
      { term: 'Edit manual', text: 'Diubah lewat Edit Stok; nama pengubahnya tercatat.' },
      { term: 'Import', text: 'Diubah lewat Import Stok (file Excel); nama pengubahnya tercatat.' },
    ],
  },
  'btn.bulkStock': {
    title: 'Edit Stok Massal',
    body: 'Mengubah stok banyak master yang dicentang sekaligus, dengan satu aturan untuk semuanya. Hasilnya langsung dikirim ke semua listing Shopee yang terikat.',
  },
  'stock.bulkColumns': {
    title: 'Kolom di daftar ini',
    items: [
      { term: 'Stok lama', text: 'Stok master sekarang, sebelum diubah. Hanya dibaca.' },
      { term: 'Di Shopee', text: 'Stok yang saat ini dipegang listing Shopee. Berwarna kuning kalau beda dengan stok master.' },
      { term: 'Stok baru', text: 'Angka yang akan disimpan. Kosongkan kalau master itu tidak mau diubah.' },
    ],
    hint: 'Tidak ada yang tersimpan sampai kamu menekan Simpan; saat itu angkanya langsung dikirim ke Shopee.',
  },
  'stock.bulkMode': {
    title: 'Cara mengisi semua sekaligus',
    items: [
      { term: 'Ganti jadi', text: 'Stok diganti menjadi angka yang kamu ketik, apa pun stok sebelumnya.' },
      { term: 'Tambah', text: 'Angka yang diketik ditambahkan ke stok sekarang. Dipakai saat barang masuk atau retur.' },
      { term: 'Kurangi', text: 'Angka yang diketik dikurangkan dari stok sekarang.' },
    ],
    hint: 'Ini hanya mengisi kolom "Stok baru" di bawah, belum menyimpan apa pun. Kamu masih bisa mengubah tiap baris.',
  },
  'btn.stockFile': {
    title: 'Export & Import Stok',
    body: 'Untuk stock opname. Export Stok mengunduh semua master beserta stoknya. Isi kolom Stok Baru dengan angka hasil hitung gudang, lalu unggah lewat Import Stok.',
    items: [
      { term: 'Stok Baru', text: 'Angka akhir. Menggantikan stok master, bukan ditambahkan. Kosongkan untuk SKU yang tidak dihitung.' },
      { term: 'Stok berubah sejak diunduh', text: 'Ada pesanan masuk setelah file diunduh. Angkamu tetap disimpan, tapi pastikan hitunganmu sudah memperhitungkan pesanan itu.' },
    ],
    hint: 'Setelah disimpan, stok dikirim ke semua listing Shopee yang terikat dan tercatat di Riwayat sebagai "Import".',
  },
  'btn.deleteMaster': {
    title: 'Hapus Master',
    body: 'Menghapus master yang dicentang. Listing yang terikat tidak ikut dihapus; ia kembali menjadi "belum dipetakan" dan bisa dijadikan master lagi dari halaman Produk. Hanya admin.',
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  'chat.list': {
    title: 'Daftar percakapan',
    items: [
      { term: 'Semua', text: 'Semua percakapan dari toko yang kamu pilih, yang terbaru di atas.' },
      { term: 'Belum dibaca', text: 'Hanya percakapan yang punya pesan pembeli yang belum dibuka. Membukanya menandainya sudah dibaca.' },
      { term: 'Angka merah', text: 'Jumlah pesan pembeli yang belum dibaca di percakapan itu. Angka total yang sama muncul di menu Chat.' },
      { term: 'Belum dibalas', text: 'Pesan terakhir dari pembeli dan belum kamu balas, walau sudah dibaca.' },
    ],
  },
  'chat.orders': {
    title: 'Pesanan pembeli',
    body: 'Pesanan pembeli ini di toko yang sama, supaya kamu bisa menjawab tanpa berpindah halaman. Tekan satu pesanan untuk membukanya di halaman Pesanan.',
    hint: 'Pesanan lama baru tertaut setelah sinkron berikutnya.',
  },
  'chat.fromSellerCentre': {
    title: 'Dari Seller Centre',
    body: 'Balasan ini dikirim lewat Seller Centre atau aplikasi Shopee, bukan dari OrderPro, jadi nama pengirimnya tidak diketahui.',
  },
  'chat.reply': {
    title: 'Balasan',
    body: 'Mengirim balasan sebagai toko ke pembeli. Enter untuk kirim, Shift+Enter untuk baris baru. Teks maksimal 600 karakter; gambar boleh JPG, PNG, atau GIF sampai 10 MB.',
    hint: 'Hanya untuk membalas. Shopee melarang pesan otomatis atau massal lewat aplikasi.',
  },

  // ── Cetak ─────────────────────────────────────────────────────────────────
  'print.page': {
    title: 'Cetak Resi',
    body: 'Halaman ini membuat resi cadangan buatan OrderPro dalam satu PDF untuk pesanan yang dipilih, lalu menandainya Dicetak. Resi resmi Shopee diunduh dari halaman Pesanan lewat "Cetak Resi Shopee".',
    hint: 'Judulnya menjadi "Cetak Ulang Resi" kalau pesanannya sudah pernah dicetak.',
  },
  'print.all': {
    title: 'Cetak Semua',
    body: 'Membuat satu PDF berisi resi semua pesanan yang sedang tampil (setelah filter kurir), lalu menandainya Dicetak.',
  },
  'print.courierFilter': {
    title: 'Filter Kurir',
    body: 'Menampilkan resi satu kurir saja, supaya paket bisa dicetak dan disusun per kurir.',
  },
  'print.preview': {
    title: 'Preview',
    body: 'Melihat resi satu pesanan sebelum dicetak.',
  },

  // ── Admin: user ───────────────────────────────────────────────────────────
  'user.role': {
    title: 'Role',
    items: [
      { term: 'ADMIN', text: 'Akses penuh: semua toko, menu Admin (user, toko, log, pengaturan), Hapus Master, dan Stok Otomatis.' },
      { term: 'STAFF', text: 'Pekerjaan harian pada toko yang diizinkan. Tidak melihat menu Admin.' },
    ],
  },
  'user.status': {
    title: 'Status',
    body: 'Aktif: bisa login. Nonaktif: tidak bisa login, tetapi datanya tidak terhapus dan bisa diaktifkan lagi kapan saja.',
  },
  'user.storeAccess': {
    title: 'Akses Toko',
    body: 'Toko yang boleh dilihat dan dikerjakan staff ini: pesanan, produk, chat, dan statistiknya. Admin selalu melihat semua toko.',
    hint: 'Staff yang tidak diberi toko apa pun tidak akan melihat data apa pun — centang minimal satu.',
  },
  'user.actions': {
    title: 'Aksi',
    items: [
      { term: 'Pensil', text: 'Ubah nama, role, akses toko, atau ganti password.' },
      { term: 'Ikon user', text: 'Nonaktifkan atau aktifkan kembali akunnya.' },
    ],
  },

  // ── Admin: log aktivitas ──────────────────────────────────────────────────
  'activity.log': {
    title: 'Log Aktivitas',
    body: 'Catatan tindakan penting yang dilakukan user di OrderPro — siapa, kapan, apa, dan berhasil atau tidak. Hanya admin yang bisa membukanya.',
  },
  'activity.failedOnly': {
    title: 'Hanya yang gagal',
    body: 'Menyaring ke tindakan yang ditolak atau gagal, misalnya pengiriman yang ditolak Shopee.',
  },
  'activity.search': {
    title: 'Cari',
    body: 'Mencari di nama tindakan, email user, dan ID sasarannya (misalnya nomor pesanan). Tekan Enter untuk mencari.',
  },
  'activity.user': {
    title: 'User',
    body: 'Tampilkan hanya tindakan yang dilakukan satu user.',
  },
  'activity.dateRange': {
    title: 'Tanggal',
    body: 'Rentang tanggal tindakan dilakukan, dalam waktu Indonesia barat (WIB). Kosongkan untuk semua tanggal yang masih disimpan.',
  },
  'activity.col.time': {
    title: 'Waktu',
    body: 'Kapan tindakan dilakukan, dalam WIB.',
  },
  'activity.col.user': {
    title: 'User',
    body: 'Akun yang melakukan tindakan, beserta emailnya.',
  },
  'activity.col.action': {
    title: 'Aksi',
    body: 'Tindakan yang dilakukan. Angka di kurung adalah ukurannya, misalnya berapa pesanan yang diproses sekaligus. Tekan baris untuk melihat rincian.',
  },
  'activity.col.result': {
    title: 'Hasil',
    body: 'Berhasil atau Gagal. Alasan kegagalan ada di rincian baris.',
  },

  // ── Naikkan Produk ────────────────────────────────────────────────────────
  'boost.page': {
    title: 'Naikkan Produk',
    body: 'Fitur Shopee yang menaikkan produk ke urutan paling atas di hasil pencarian. Tiap toko boleh menaikkan 5 produk, dan tiap slot baru bisa dipakai lagi 4 jam kemudian.',
    hint: 'Nyalakan Otomatis supaya kelima slot selalu terpakai tanpa perlu diingat-ingat.',
  },
  'boost.auto': {
    title: 'Naikkan otomatis',
    body: 'Kalau menyala, OrderPro mengecek toko ini tiap 10 menit. Begitu ada slot yang kosong, slot itu langsung diisi produk berikutnya dalam antrean.',
    items: [
      { term: 'Antrean', text: 'Semua produk yang sedang aktif dijual, digilir bergantian. Yang belum pernah dinaikkan didahulukan, lalu yang paling lama tidak dinaikkan.' },
      { term: 'Dilewati', text: 'Produk yang stoknya habis (menurut katalog terakhir), dan produk yang sedang dinaikkan.' },
      { term: 'Manual di Seller Centre', text: 'Ikut terhitung. Slot yang dipakai lewat Seller Centre tidak akan ditimpa.' },
    ],
  },
  'boost.slots': {
    title: 'Slot terpakai',
    body: 'Berapa dari 5 slot yang sedang dipakai. Angka ini dibaca langsung dari Shopee, termasuk produk yang dinaikkan manual di Seller Centre.',
    hint: 'Jam di samping tiap produk adalah sisa waktu sampai slotnya bisa dipakai lagi.',
  },
  'boost.next': {
    title: 'Antrean berikutnya',
    body: 'Produk yang akan dinaikkan saat slot kosong. Ini perkiraan dari katalog terakhir. Produk baru yang belum ditarik ke katalog tetap ikut dinaikkan, hanya belum terlihat di sini.',
  },
  'boost.history': {
    title: 'Riwayat',
    body: 'Produk yang sudah dinaikkan, terbaru di atas. "Manual" berarti lewat tombol Naikkan Sekarang. Yang gagal menampilkan alasan dari Shopee, lalu dipindah ke belakang antrean.',
  },

  // ── Admin: pengaturan ─────────────────────────────────────────────────────
  'check.system': {
    title: 'Cek Sistem',
    body: 'Memeriksa apakah aplikasi masih terhubung dengan semua yang dibutuhkannya: database, antrean, folder penyimpanan, dan Shopee.',
    hint: 'Hijau berarti jalurnya sehat, bukan berarti datanya benar. Untuk itu lihat lencana "Cocok dengan Shopee" di halaman Pesanan.',
  },
  'check.status': {
    title: 'Hasil pemeriksaan',
    items: [
      { term: 'Sehat', text: 'Berjalan normal.' },
      { term: 'Perhatian', text: 'Masih jalan tetapi ada yang janggal; sebaiknya dilihat.' },
      { term: 'Gagal', text: 'Tidak berfungsi. Kata-kata dari server di bawahnya adalah diagnosisnya — salin lewat "Salin Hasil" untuk dikirim ke developer.' },
    ],
    hint: 'Di bawah tiap pemeriksaan tertulis jenisnya: "hanya membaca" (tidak mengubah apa pun), "memanggil Shopee" (menanyakan sesuatu tanpa mengubah data), atau "menulis 1 berkas sementara" (menulis berkas kecil untuk memastikan folder bisa ditulis, lalu menghapusnya).',
  },
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryKey = keyof typeof GLOSSARY

/**
 * The glossary key for a value that arrives at runtime — an order status, a
 * listing status — or null when there is no entry for it. A status Shopee adds
 * tomorrow should show no "?" rather than a broken one.
 */
export function glossaryKey(prefix: string, value: string | null | undefined): GlossaryKey | null {
  if (!value) return null
  const key = `${prefix}.${value}`
  return key in GLOSSARY ? (key as GlossaryKey) : null
}
