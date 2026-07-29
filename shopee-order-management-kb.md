# Shopee Open API — Order Management (Knowledge Base untuk AI Agent)

> Sumber: Shopee Open Platform, Order Management (last updated 2025-09-24).
> Dokumen ini ditulis sebagai **rujukan operasional agent**: enum eksplisit, aturan deterministik, dan urutan pemanggilan API. Semua nama API, status, dan field ditulis persis seperti API — jangan diterjemahkan.

---

## 0. Aturan Wajib untuk Agent

1. **Jangan pernah menebak status.** Selalu ambil status aktual via `v2.order.get_order_detail` atau `v2.order.get_package_detail` sebelum aksi tulis (ship, split, cancel, print AWB).
2. **Satu mode pengiriman saja.** `get_shipping_parameter` bisa mengembalikan beberapa mode di `info_needed`; agent WAJIB memilih **tepat satu** (`pickup` / `dropoff` / `non_integrated`).
3. **Jangan asumsikan field ada.** Banyak field hanya muncul jika diminta lewat `response_optional_fields`. Kalau field hilang → cek parameter request dulu, bukan lapor bug.
4. **Preferensikan `v2.order.search_package_list`**, bukan `v2.order.get_shipment_list` (akan deprecated).
5. **Package = unit pengiriman**, bukan order. Untuk semua alur fulfillment, iterasi per package.
6. **Idempotensi**: sebelum retry `ship_order`, cek ulang fulfillment status. Kalau sudah `LOGISTICS_REQUEST_CREATED`, jangan kirim ulang.
7. **Polling**: `get_shippping_document_result` (perhatikan typo "shippping" — memang begitu di API) harus dipoll sampai status `READY`. Gunakan backoff, jangan tight loop.

---

## 1. Model Entitas

| Entitas | Definisi | Relasi |
|---|---|---|
| **Order** | Dibuat setelah checkout | 1 order → banyak item |
| **Package** | Dibuat setelah order; unit pengiriman | 1 order → 1..N package |
| **Item** | Produk individual (qty, model) | Item masuk ke dalam package |

Identifier kunci: `order_sn`, `package_number`, `item_id`, `model_id`, `order_item_id`, `promotion_group_id`.

---

## 2. Order Status Flow

### 2.1 Enum Order Status

| Status | Arti |
|---|---|
| `UNPAID` | Order dibuat, buyer belum bayar |
| `READY_TO_SHIP` | Pembayaran terverifikasi; seller boleh atur pengiriman |
| `PROCESSED` | Seller sudah `ship_order` (tracking number bisa jadi belum terbit) |
| `SHIPPED` | Paket sudah di-dropoff / dipickup 3PL (kurir scan AWB) |
| `TO_CONFIRM_RECEIVE` | Sudah diterima buyer |
| `COMPLETED` | Order selesai |
| `RETRY_SHIP` | Pickup 3PL gagal; perlu atur ulang pengiriman |
| `IN_CANCEL` | Pembatalan sedang diproses (butuh approval seller) |
| `CANCELLED` | Order dibatalkan |
| `TO_RETURN` | Buyer request return, sedang diproses |

### 2.2 Transisi

```
UNPAID ──(payment verified)──> READY_TO_SHIP
READY_TO_SHIP ──(ship_order)──> PROCESSED
PROCESSED ──(kurir scan AWB)──> SHIPPED
SHIPPED ──> TO_CONFIRM_RECEIVE ──> COMPLETED

# Cabang tambahan
READY_TO_SHIP ──(pickup gagal)──> RETRY_SHIP ──(update_shipping_order)──> PROCESSED
READY_TO_SHIP / PROCESSED ──(cancel)──> CANCELLED
READY_TO_SHIP / PROCESSED ──(buyer req + butuh approval)──> IN_CANCEL
    ├─ seller reject ──> kembali ke status sebelumnya
    └─ seller approve / no response ──> CANCELLED
READY_TO_SHIP ──(seller telat ship melewati auto-cancel time)──> CANCELLED
SHIPPED ──(paket hilang)──> CANCELLED
SHIPPED ──(buyer request return)──> TO_RETURN ──(return confirmed)──> COMPLETED
```

Catatan:
- Buyer bisa cancel **tanpa** approval seller sebelum status `SHIPPED` (tergantung kebijakan market).
- Kalau return disengketakan → masuk arbitrase Shopee.

### 2.3 Mapping OpenAPI ↔ Seller Centre

| OpenAPI | Seller Centre |
|---|---|
| `UNPAID` | Unpaid |
| `READY_TO_SHIP` | To ship (To ship) |
| `RETRY_SHIP` | To ship (To ship) |
| `PROCESSED` | To ship (Processed) |
| `IN_CANCEL` | Cancellation (Cancellation Requested) / Shipped (Cancellation Requested) |
| `CANCELLED` | Cancellation (Cancelled) |
| `SHIPPED` | Shipping (Shipped) |
| `TO_RETURN` | Return/Refund (Return Pending) / Shipping (Request Return/Refund) |
| `TO_CONFIRM_RECEIVE` | Shipping (Shipped) |
| `COMPLETED` | Completed |

> Berguna saat agent menjelaskan hasil ke user yang terbiasa lihat Seller Centre.

---

## 3. Package Status & Fulfillment Status

### 3.1 Package Status (filter numerik di `search_package_list`)

| Value | Nama | Fulfillment Status yang tercakup | Filter Seller Centre |
|---|---|---|---|
| `0` | All | `LOGISTICS_NOT_START`, `LOGISTICS_READY`, `LOGISTICS_PICKUP_RETRY`, `LOGISTICS_REQUEST_CREATED` | All |
| `1` | Pending | `LOGISTICS_NOT_START` | Pending |
| `2` | ToProcess | `LOGISTICS_READY`, `LOGISTICS_PICKUP_RETRY` | To Process |
| `3` | Processed | `LOGISTICS_REQUEST_CREATED` | Processed |

**Untuk ambil paket yang siap dikirim → gunakan `package_status = 2`.**

### 3.2 Enum Fulfillment / Logistics Status

| Status | Arti |
|---|---|
| `LOGISTICS_NOT_START` | Package dibuat, belum siap fulfillment |
| `LOGISTICS_READY` | Siap fulfillment (non-COD: sudah bayar; COD: lolos screening) |
| `LOGISTICS_REQUEST_CREATED` | Sudah diatur pengiriman |
| `LOGISTICS_PICKUP_DONE` | Sudah diserahkan ke 3PL |
| `LOGISTICS_DELIVERY_DONE` | Terkirim |
| `LOGISTICS_INVALID` | Dibatalkan saat `LOGISTICS_READY` |
| `LOGISTICS_REQUEST_CANCELED` | Dibatalkan saat `LOGISTICS_REQUEST_CREATED` |
| `LOGISTICS_PICKUP_FAILED` | Dibatalkan 3PL karena pickup gagal / tidak bisa dikirim |
| `LOGISTICS_PICKUP_RETRY` | Menunggu 3PL pickup ulang |
| `LOGISTICS_DELIVERY_FAILED` | Dibatalkan karena pengiriman gagal |
| `LOGISTICS_LOST` | Dibatalkan karena 3PL kehilangan paket |

Nilai legacy tambahan yang **hanya muncul di `get_order_detail`**:
- `LOGISTICS_PENDING_ARRANGE` — logistik menunggu pengaturan
- `LOGISTICS_COD_REJECTED` — order COD ditolak

### 3.3 Transisi Fulfillment

```
START ──1──> LOGISTICS_NOT_START ──2──> LOGISTICS_READY ──3──> LOGISTICS_REQUEST_CREATED
      ──4──> LOGISTICS_PICKUP_DONE ──5──> LOGISTICS_DELIVERY_DONE ──> END

LOGISTICS_READY            ──6──> LOGISTICS_INVALID
LOGISTICS_REQUEST_CREATED  ──7──> LOGISTICS_REQUEST_CANCELED
LOGISTICS_REQUEST_CREATED  ──8──> LOGISTICS_PICKUP_FAILED
LOGISTICS_REQUEST_CREATED  ──9──> LOGISTICS_PICKUP_RETRY ──8──> LOGISTICS_PICKUP_FAILED
LOGISTICS_PICKUP_RETRY     ──4──> LOGISTICS_PICKUP_DONE
LOGISTICS_PICKUP_DONE      ──10─> LOGISTICS_DELIVERY_FAILED
LOGISTICS_PICKUP_DONE      ──11─> LOGISTICS_LOST
```

Saat `LOGISTICS_PICKUP_RETRY`, seller bisa update alamat & waktu pickup lewat `v2.logistics.update_shipping_order`.

---

## 4. Katalog API

### 4.1 Order
| API | Fungsi |
|---|---|
| `v2.order.get_order_list` | List order per status |
| `v2.order.get_order_detail` | Detail order |
| `v2.order.cancel_order` | Seller membatalkan order |
| `v2.order.handle_buyer_cancellation` | Approve/reject request cancel dari buyer |
| `v2.order.split_order` | Pecah order jadi beberapa package |
| `v2.order.unsplit_order` | Batalkan split |
| `v2.order.search_package_list` | List package belum dikirim (**preferred**) |
| `v2.order.get_package_detail` | Detail package |
| `v2.order.get_shipment_list` | ⚠️ Deprecated soon — pakai `search_package_list` |
| `v2.order.add_invoice_data` | Tambah invoice untuk status `PENDING_INVOICE` (khusus seller lokal BR) |

### 4.2 Logistics
| API | Fungsi |
|---|---|
| `v2.logistics.get_shipping_parameter` | Parameter pengiriman, 1 package |
| `v2.logistics.get_mass_shipping_parameter` | Batch, syarat: channel + warehouse sama |
| `v2.logistics.ship_order` | Atur pengiriman, 1 package |
| `v2.logistics.mass_ship_order` | Batch, syarat: channel + warehouse sama |
| `v2.logistics.update_shipping_order` | Update `address_id` & `pickup_time_id` (mode pickup, status `RETRY_SHIP`) |
| `v2.logistics.get_tracking_number` | Ambil tracking number, 1 package |
| `v2.logistics.get_mass_tracking_number` | Batch |
| `v2.logistics.get_shipping_document_data_info` | Data mentah untuk **self-print** AWB |
| `v2.logistics.get_shipping_document_parameter` | Tipe AWB yang tersedia + rekomendasi |
| `v2.logistics.create_shipping_document` | Buat task AWB |
| `v2.logistics.get_shippping_document_result` | Cek status task AWB |
| `v2.logistics.download_shipping_document` | Download AWB |
| `v2.logistics.get_tracking_info` | Tracking event 3PL |

---

## 5. Alur Fulfillment (Urutan Eksekusi Agent)

```
1. search_package_list(package_status=2)        → dapat order_sn + package_number
2. get_package_detail                           → validasi isi & channel
3. [opsional] split order? → split_order        → hanya jika order_status == READY_TO_SHIP
4. get_shipping_parameter / get_mass_shipping_parameter
5. pilih SATU mode dari info_needed → ship_order / mass_ship_order
6. get_tracking_number / get_mass_tracking_number  (retry jika belum terbit)
7. AWB:
   a. self-design  → get_shipping_document_data_info → render sendiri
   b. Shopee-generated →
        get_shipping_document_parameter
        create_shipping_document
        get_shippping_document_result   (poll sampai READY)
        download_shipping_document
```

**Constraint waktu print AWB:** hanya boleh setelah pengiriman berhasil diatur **dan sebelum** fulfillment status jadi `LOGISTICS_PICKUP_DONE`.

### 5.1 Payload `ship_order` per mode

Mode ditentukan dari `info_needed` pada response `get_shipping_parameter`.

**pickup** (`info_needed.pickup` berisi `address_id`, `pickup_time_id`):
```json
{
  "order_sn": "2112132KQ1MK9N",
  "pickup": {
    "address_id": 2826,
    "pickup_time_id": "1639472400"
  }
}
```

**dropoff** (`info_needed.dropoff` kosong) — object kosong tetap **wajib** dikirim:
```json
{
  "order_sn": "220301QQY0WASP",
  "dropoff": {}
}
```
Jika channel mengembalikan field lain, isi field tersebut:
```json
{
  "order_sn": "220301QQY0WASP",
  "dropoff": { "sender_real_name": "ABC" }
}
```

**non_integrated** (`info_needed.non_integrated` = `tracking_number`) — agent/seller menyiapkan resi sendiri:
```json
{
  "order_sn": "220301QQY0WASP",
  "non_integrated": {
    "tracking_number": "AK224200239740W"
  }
}
```

**update_shipping_order** (status `RETRY_SHIP`, mode pickup):
```json
{
  "order_sn": "2112132KQ1MK9N",
  "pickup": {
    "address_id": 11178,
    "pickup_time_id": "1658563200"
  }
}
```

### 5.2 Efek status setelah `ship_order` berhasil

| Mode | Fulfillment status setelahnya |
|---|---|
| pickup / dropoff | `LOGISTICS_READY` → `LOGISTICS_REQUEST_CREATED` |
| non_integrated | langsung → `LOGISTICS_PICKUP_DONE` |

Order status → `PROCESSED` (meski tracking number belum terbit).

---

## 6. Split Order — Aturan Ketat

**Prasyarat:** `order_status == READY_TO_SHIP`.

| # | Aturan |
|---|---|
| 1 | Permission split adalah level toko. Error `"You don't have the permission to split order."` → harus apply ke Shopee business manager. |
| 2 | Item dalam **Bundle deal** atau **Add-on deal** yang sama tidak boleh dipisah ke package berbeda (kecuali selected seller). |
| 3 | Deteksi bundle: `order_item_id` sama di `get_order_detail`. Deteksi add-on: `add_on_deal_id` sama. |
| 4 | Split hanya di level **item** dan **model**. Jika buyer beli >1 qty dengan `item_id` + `model_id` identik → **tidak bisa displit** (kecuali selected seller). Contoh: HP A biru + HP A merah → bisa. 2× HP A biru → tidak bisa. |
| 5 | Minimal **2 package** per request (minimal 2 `item_list`). Maksimal 30 package di TW, 5 package di region lain. |
| 6 | Request **harus memuat seluruh item** dalam order. |
| 7 | `unsplit_order` hanya bisa saat `READY_TO_SHIP`; jika ada parcel sudah dikirim, split tidak bisa dibatalkan. |

**Contoh request** (6 item → 2 package):
```json
{
  "order_sn": "2204215JYEEFW0",
  "package_list": [
    {
      "item_list": [
        { "item_id": 1220089094, "model_id": 0, "order_item_id": 1220089094, "promotion_group_id": 1051400341536827267 }
      ]
    },
    {
      "item_list": [
        { "item_id": 2436030646, "model_id": 5074620257, "order_item_id": 2436030646, "promotion_group_id": 0 },
        { "item_id": 7348262532, "model_id": 0, "order_item_id": 7348262532, "promotion_group_id": 0 },
        { "item_id": 13772515222, "model_id": 0, "order_item_id": 13772515222, "promotion_group_id": 0 },
        { "item_id": 1229323224, "model_id": 1434025516, "order_item_id": 1229323224, "promotion_group_id": 0 },
        { "item_id": 1229323224, "model_id": 1434025517, "order_item_id": 1229323224, "promotion_group_id": 0 }
      ]
    }
  ]
}
```

---

## 7. Airway Bill (AWB)

### 7.1 Tipe dokumen
`NORMAL_AIR_WAYBILL`, `THERMAL_AIR_WAYBILL`, `NORMAL_JOB_AIR_WAYBILL`, `THERMAL_JOB_AIR_WAYBILL`.

Jika agent tidak memilih tipe, Shopee memakai tipe default.

### 7.2 Format file yang dikembalikan
- Mayoritas order → **PDF**.
- TW C2C: semua **HTML**. TW B2C: PDF, **kecuali** channel berikut yang HTML — 7-ELEVEN (`30005`), Family Mart (`30006`), Lai Erfu (`30007`), Family Frozen Super Pickup non-outlying (`30011`), OK Mart (`30014`).
- Jika setting Seller Centre = thermal printing → dikembalikan **ZIP**.

Agent harus mendeteksi format dari content-type/magic bytes, jangan asumsi PDF.

### 7.3 Aturan
- `create_shipping_document` hanya jalan saat `order_status == PROCESSED`, dan hanya setelah tracking number terbit.
- `download_shipping_document` gagal jika ada satu saja package di request yang status dokumennya bukan `READY`.

---

## 8. Kasus Khusus Taiwan (TW)

1. `get_shipping_parameter` mengembalikan parameter `slug`. **`slug` wajib** dikirim saat `ship_order`, kalau tidak pengiriman gagal.
2. Channel 黑猫宅急便 (`30001`): tidak perlu print AWB — 3PL yang menyediakan AWB dan melakukan pickup. Memanggil `create_shipping_document` akan error `"The package can not print now."`

---

## 9. Troubleshooting (Error → Diagnosa → Aksi)

| Error / Gejala | Penyebab | Aksi agent |
|---|---|---|
| `"Wrong parameters, detail: the order is not found."` | order_sn salah / di luar scope shop | Validasi `order_sn` & `shop_id` |
| Banyak field hilang di `get_order_detail` | `response_optional_fields` tidak diisi | Isi ulang `response_optional_fields` |
| Time slot pickup kosong | Order sudah dikirim, atau `ship_by_day` lewat | Cek order status; jika lewat → eskalasi manual |
| `"logistic status not ready to ship"` | Status bukan `READY_TO_SHIP` | `get_order_detail` dulu; hanya ship saat `READY_TO_SHIP` |
| `first_mile_tracking_number` tidak ada | `response_optional_fields` tidak diisi | Tambahkan field terkait |
| `"Order status does not support awb printing"` | Status bukan `PROCESSED` | Tunggu/cek status |
| `get_shippping_document_result` = `PROCESSING` | Task AWB belum selesai | Poll berkala sampai `READY` |
| `"You don't have the permission to split order."` | Permission level toko | Eskalasi ke Shopee business manager |
| Tracking number belum terbit di package `Processed` | Delay 3PL | Retry `get_tracking_number` berkala |

---

## 10. Enum Referensi

### 10.1 Order cancellation reason (seller)
`OUT_OF_STOCK`, `UNDELIVERABLE_AREA`

### 10.2 Cancel reason (sistem/umum)
Out of Stock · Buyer Request to Cancel · Undeliverable Area · COD Unsupported · Parcel is Lost · Game Completed · Unpaid Order · Underpaid Order · Unsuccessful / Rejected Payment · Logistics Request is Cancelled · 3PL pickup Fail · Failed Delivery · COD Rejected · Seller did not Ship · Transit Warehouse Cancelled · Other · Inactive Seller · Auto Cancel · Logistic Issue · Approver did not approve on time · Unable to place order · TBC

### 10.3 Buyer cancel reason
Seller is not Responsive · Seller ask Buyer to Cancel · Modify Existing Order · Product has Bad Reviews · Seller Takes too Long to Ship · Seller is Untrustworthy · Forgot to Input Voucher Code · Need to change delivery address · Need to input/Change Voucher Code · Need to Modify Order · Payment Procedure too Troublesome · Found Cheaper Elsewhere · Don't Want to Buy Anymore · Approver rejected the order · Unable to place order · Too long delivery time · Modify existing order (color, size, voucher, etc) · Change of mind / others · Others

### 10.4 Package logistics track status (`get_tracking_info`)
`INITIAL`, `ORDER_INIT`, `ORDER_SUBMITTED`, `ORDER_FINALIZED`, `ORDER_CREATED`, `PICKUP_REQUESTED`, `PICKUP_PENDING`, `PICKED_UP`, `DELIVERY_PENDING`, `DELIVERED`, `PICKUP_RETRY`, `TIMEOUT`, `LOST`, `UPDATE`, `UPDATE_SUBMITTED`, `UPDATE_CREATED`, `RETURN_STARTED`, `RETURNED`, `RETURN_PENDING`, `RETURN_INITIATED`, `EXPIRED`, `CANCEL`, `CANCEL_CREATED`, `CANCELED`, `FAILED_ORDER_INIT`, `FAILED_ORDER_SUBMITTED`, `FAILED_ORDER_CREATED`, `FAILED_PICKUP_REQUESTED`, `FAILED_PICKED_UP`, `FAILED_DELIVERED`, `FAILED_UPDATE_SUBMITTED`, `FAILED_UPDATE_CREATED`, `FAILED_RETURN_STARTED`, `FAILED_RETURNED`, `FAILED_CANCEL_CREATED`, `FAILED_CANCELED`

---

## 11. Pseudocode Referensi

```python
def fulfill_ready_packages(shop):
    packages = search_package_list(package_status=2)          # ToProcess

    for pkg in packages:
        detail = get_package_detail(pkg.package_number)
        if detail.logistics_status not in ("LOGISTICS_READY", "LOGISTICS_PICKUP_RETRY"):
            continue                                           # skip, bukan tanggung jawab step ini

        param = get_shipping_parameter(pkg.order_sn, pkg.package_number)
        mode, body = pick_single_mode(param["info_needed"])     # pickup | dropoff | non_integrated
        if shop.region == "TW":
            body["slug"] = param["slug"]                        # wajib di TW

        ship_order(pkg.order_sn, pkg.package_number, **{mode: body})

        tn = poll(lambda: get_tracking_number(pkg.order_sn), until=lambda r: r.tracking_number)

        if shop.self_print_awb:
            data = get_shipping_document_data_info(pkg.order_sn)
            render_awb(data)
        else:
            doc_param = get_shipping_document_parameter(pkg.order_sn)
            create_shipping_document(pkg.order_sn, doc_param.suggest_shipping_document_type)
            poll(lambda: get_shippping_document_result(pkg.order_sn), until=lambda r: r.status == "READY")
            blob = download_shipping_document(pkg.order_sn)
            save(blob, detect_format(blob))                     # pdf | html | zip
```

`pick_single_mode` — prioritas default yang disarankan: `pickup` > `dropoff` > `non_integrated`, kecuali kebijakan toko menentukan lain. Kalau `info_needed` hanya mengembalikan satu mode, mode itulah satu-satunya yang valid.
