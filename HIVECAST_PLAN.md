# HiveCast Implementation Plan

> **Pembaruan (9 Nov 2026):** domain cuaca tidak lagi memakai Kudus. Sekarang satu Question per kota per hari lokal untuk Jakarta, Singapura, London, Dubai, dan Tokyo (`weatherCities` di config runner); replay offline memakai Jakarta. Rujukan Kudus di bawah adalah desain awal. Aturan terkini ada di [RULES.md](RULES.md).

Status: desain disepakati melalui grill-with-docs, Q1–Q40. Dokumen ini adalah rencana implementasi, bukan laporan fitur yang sudah berjalan. Implementasi aplikasi dan bundel data belum dibuat pada tahap desain ini.

## 1. Produk dan batas kepercayaan

HiveCast adalah sistem **Forecast Wagering** untuk Question biner bertanggal, disertai penjualan akses awal ke **Forecast Snapshot**. Agen mempertaruhkan dana pada probabilitas, bukan memperdagangkan saham YES/NO. Satu Question memiliki tepat satu Round; kejadian berulang dibuat sebagai Question baru.

Versi yang dirancang adalah demo edukasional nonkomersial dengan testNEAR di NEAR testnet. Ada simulasi historis offline dan skenario sandbox yang dibedakan dari data live. Tidak ada deployment mainnet atau layanan produksi berbayar dalam cakupan ini.

Operator dipercaya untuk mengetahui dan menjaga forecast privat, menghasilkan agregat, melayani pembeli, serta menentukan outcome melalui resolver yang ditunjuk. Kontrak memverifikasi commitment dan perhitungan dana; kontrak tidak membuktikan kebenaran sumber outcome atau delivery layanan. Operator tetap memegang full-access deploy key testnet. Aturan Question tidak bisa diedit melalui API normal, tetapi kode masih bisa diganti oleh pemegang deploy key. Larangan upgrade selama ada Round aktif atau kewajiban dana adalah prosedur operasional, bukan pembatasan kriptografis.

Baca [GLOSSARY.md](GLOSSARY.md) untuk istilah, [ADR operator](docs/adr/0001-trusted-operator.md), dan [ADR query fee](docs/adr/0002-stake-weighted-query-fees.md) untuk alasan keputusan.

## 2. Question dan lifecycle

Hanya operator boleh membuat Question. Teks, definisi kejadian, sumber/model/instrumen, jadwal, resolver, harga akses, dan minimum stake disimpan sebagai aturan immutable melalui API untuk Question tersebut.

Simpan `open_time`, `close_time`, `observation_start`, `observation_end`, `resolve_time`, `resolve_deadline`, dan `reveal_window`. Semua timestamp on-chain memakai nanodetik UTC; tampilkan timezone domain di UI. `resolve_time` adalah waktu paling awal resolusi, bukan janji kapan resolver akan bertindak.

Validasi urutan: `open_time < close_time < observation_start < observation_end <= resolve_time < resolve_deadline`; `reveal_window > 0`. Default `resolve_time = observation_end`. Deadline reveal hanya ditetapkan setelah resolusi: `resolved_at + reveal_window`.

| State | Aturan |
| --- | --- |
| OPEN | Commitment diterima pada `open_time <= now < close_time`; sebelum `open_time`, Question terjadwal belum menerima commitment. |
| CLOSED | Mulai `now >= close_time` bila belum resolved/cancelled. Tidak menerima commitment. Penjualan hanya pada sub-window sebelum `observation_start` dan setelah snapshot siap. |
| RESOLVED | Resolver yang dikunci untuk Question mencatat satu outcome pada `resolve_time <= now < resolve_deadline`. Reveal diterima sampai sebelum `reveal_deadline`. |
| SETTLED | Siapa pun boleh memicu settlement pada `now >= reveal_deadline`. Payout ditetapkan sekali; tidak ada reveal lagi. |
| CANCELLED | Jalur terminal bila tidak ada commitment valid saat penutupan, atau deadline resolusi terlewati tanpa outcome. Semua stake dan query fee dikembalikan sebagai hak klaim. |

Empat fase normal adalah OPEN → CLOSED → RESOLVED → SETTLED; CANCELLED adalah pengecualian, bukan outcome NO. State terminal/resolusi harus mengalahkan state yang diturunkan dari waktu. Tidak perlu transaksi khusus untuk membuat waktu penutupan berlaku.

Batas waktu memakai interval setengah terbuka: commit/buy/reveal/resolve menolak pada deadline masing-masing; settle/cancel karena timeout menerima mulai deadline. Resolusi dan pembatalan saling eksklusif. Outcome final setelah resolusi; tidak ada banding atau edit setelah agen mulai reveal.

### Jadwal default

| Parameter | Harga NEAR/USDT | Presipitasi Kudus |
| --- | --- | --- |
| Awal observasi | Awal jam UTC target | 00.00 WIB tanggal target |
| Akhir observasi | Satu jam kemudian | 00.00 WIB hari berikutnya |
| Pembukaan commitment | 15 menit sebelum observasi | 18.00 WIB hari sebelumnya |
| Penutupan commitment | 5 menit sebelum observasi | 23.55 WIB hari sebelumnya |
| Penjualan snapshot | Setelah penutupan, sebelum observasi | Setelah penutupan, sebelum observasi |
| Deadline resolusi | 15 menit setelah akhir observasi | 48 jam setelah akhir observasi |
| Reveal window | 15 menit sejak resolusi aktual | 15 menit sejak resolusi aktual |

Sandbox boleh memperpendek waktu untuk menguji lifecycle, tetapi tidak boleh dipresentasikan sebagai hasil kejadian live yang dipercepat.

## 3. Peserta dan commitment

Minimum satu dan maksimum 64 commitment per Question. Nol commitment menyebabkan pembatalan setelah penutupan. Satu peserta boleh berjalan: payout dasar mengembalikan stake-nya; jika reveal valid, ia menerima seluruh query fee. UI harus menyebutnya **Single-agent Forecast**, bukan swarm atau kompetisi multiagen.

Batas peserta adalah per akun, bukan per manusia/operator. Tidak ada klaim perlindungan Sybil atau independensi pengendali akun.

Setiap akun hanya boleh mengirim satu commitment final per Question. Tidak ada overwrite, top-up stake, atau penarikan stake selama Round aktif. Attached deposit commitment seluruhnya menjadi stake. Minimum default 0,1 NEAR; total stake per Question dibatasi 1 juta NEAR.

Gunakan SHA-256 atas encoding kanonik ber-versi yang mengikat: domain/version, contract ID, question ID, account agen, stake, probabilitas bps, dan salt. String/byte field harus memiliki batas panjang/encoding yang tidak ambigu; jangan konkatenasi string variabel tanpa framing. Salt dibuat dengan CSPRNG dan disimpan sebelum transaksi commitment dikirim. Probabilitas valid adalah integer `0..=10000`.

Reveal harus berasal dari akun peserta yang terikat, cocok dengan commitment, terjadi pada fase RESOLVED sebelum deadline, dan hanya diterima sekali. Forecast tidak valid atau tidak diungkapkan tidak menghasilkan skor valid. Non-reveal mendapat skor nol untuk wagering; ini tidak berarti seluruh stake disita.

## 4. Snapshot, pembayaran, dan akses

Produk utama adalah rata-rata probabilitas berbobot stake Round:

`aggregate_bps = sum(stake_i * prob_bps_i) / sum(stake_i)`.

Pertahankan presisi rasional/fixed-point dan nyatakan pembulatan untuk tampilan. Bobot bukan saldo bankroll terkini. Log-odds hanya pembanding simulasi, bukan forecast berbayar; bila ditampilkan, aturan clipping 0%/100% harus dinyatakan.

Setelah commitment ditutup, operator mencocokkan forecast/salt privat dengan seluruh commitment dan membekukan tepat satu snapshot. Snapshot belum layak dijual bila ada commitment yang forecast cocoknya belum tersedia. Snapshot tidak diperbarui atau direweight berdasarkan peserta yang kemudian reveal. Salinannya disimpan secara durable di runner; publikasi readiness dan identitas snapshot dilakukan sebelum pembelian. Readiness tidak menambah fase lifecycle.

Jangan memublikasikan probabilitas privat atau hash tanpa salt atas nilai probabilitas yang ruang kemungkinannya kecil. Identitas snapshot publik bukan bukti kebenaran agregasi; operator tetap dipercaya sesuai ADR.

`buy_forecast` menerima harga tepat sesuai Question, default 0,01 NEAR. Tolak underpayment, overpayment, pembelian duplikat, snapshot belum siap, fase/waktu keliru, atau pembelian yang membuat fee pot melampaui 1 juta NEAR. Satu akun membeli sekali; akses ulang ke snapshot yang sama tanpa fee tambahan.

Receipt on-chain adalah hak akses, bukan forecast itu sendiri. Endpoint operator memerlukan bukti kepemilikan akun: challenge sekali pakai dengan masa berlaku yang terikat ke domain layanan, network, contract, dan akun; periksa receipt final di kontrak/network yang benar. Mengetahui account ID atau transaction hash publik tidak cukup untuk mengambil forecast privat.

Jual hanya setelah `close_time` dan sebelum `observation_start`. Nilai produk adalah akses awal, bukan kepemilikan eksklusif atau rahasia permanen. Pembeli dapat membagikan forecast; setelah reveal, sebagian atau seluruh informasi bisa menjadi publik.

Retry delivery tidak ditagih ulang. Kontrak tidak mendeteksi endpoint mati atau menjamin refund otomatis untuk kegagalan delivery. Refund otomatis yang disepakati adalah pembatalan dan nol reveal valid. Kegagalan layanan lainnya menjadi tanggung jawab operator, tanpa klaim fair exchange trustless.

## 5. Scoring dan konservasi dana

Gunakan yoctoNEAR untuk dana, bps untuk probabilitas, dan `S = 100_000_000`. Untuk outcome `o` bernilai `0` atau `10000`:

- Reveal valid: `s_i = S - (p_i - o)^2`.
- Tidak reveal valid: `s_i = 0`.
- `W = sum(w_i)` untuk semua commitment valid yang diterima.
- `A = sum(w_i * s_i)`.

Payout dasar eksak, sebelum pembulatan:

`base_i = w_i * (W*S + W*s_i - A) / (W*S)`.

Ini setara dengan weighted-score wagering tanpa membulatkan skor rata-rata terlebih dahulu. Tetap sertakan stake non-revealer dalam `W`; jangan menghapusnya dari kompetisi setelah mengetahui outcome.

Untuk query fee `F`, ambil `V = sum(w_i)` hanya di antara Valid Revealer:

- Jika `V > 0`, `fee_i = F * w_i / V` untuk Valid Revealer, nol untuk lainnya.
- Jika `V = 0`, seluruh query fee menjadi refund pembeli; payout dasar mengembalikan masing-masing stake karena semua skor nol.
- Reveal valid dengan skor nol tetap berhak atas fee; total skor nol bukan alasan refund bila ada reveal valid.

Untuk masing-masing pot dasar dan fee, bulatkan jatah ke bawah, urutkan pecahan sisa terbesar, lalu bagikan sisa yoctoNEAR satu per satu. Tie-break adalah account ID ascending secara kanonik. Jangan menggabungkan kedua pot sebelum pembulatan.

Invarian per Question, tanpa menghitung storage sponsor atau gas:

`sum(base_payouts) = W`.

`sum(fee_payouts) + sum(buyer_fee_refunds) = F`.

Pembatalan mengembalikan `W` kepada pemilik stake dan `F` kepada pembeli tanpa scoring. Tidak ada dust yang menjadi pendapatan operator.

Semua produk antara dihitung dengan integer lebar, misalnya U256 dengan input bounds dan checked arithmetic; `near-sdk` 5.5.0 tidak menyediakan U256. Plafon `W,F <= 10^30` yoctoNEAR membuat batas atas pembilang dasar `2*W^2*S <= 2*10^68`, di bawah `2^256`. Pembilang fee paling besar `10^60`. Tolak input/pot yang melewati batas sebelum mengubah state.

Proper scoring adalah sifat wagering dalam kondisi stake dan peserta tetap, minimal dua peserta, dan reveal valid; bukan jaminan terhadap Sybil, kolusi, pilihan partisipasi/stake, atau operator yang memanipulasi outcome. Fee berbobot stake dipilih karena fee berbobot skor dapat mengubah insentif pelaporan. Swarm tidak dijamin mengalahkan setiap agen atau baseline.

## 6. Storage, kewajiban dana, dan withdrawal

Operator menyediakan cadangan storage terpisah. Seluruh stake dan query fee adalah kewajiban kepada pengguna, bukan uang bebas untuk biaya storage. Ukur state growth dan tolak record baru bila cadangan sponsor tidak cukup; reserve juga kebutuhan ledger/status yang akan dipakai setelahnya.

Settlement terbatas pada paling banyak 64 agen dan mencatat Claimable Balance, bukan membuat transfer untuk semua peserta. Bounded settlement wajib dibuktikan dengan pengukuran gas. View list/leaderboard memakai pagination dan limit.

Pembatalan atau kondisi nol reveal menetapkan eligibility refund. Pembeli mengklaim refund dari receipt masing-masing dengan flag sekali klaim; jangan memindai seluruh pembeli dalam satu settlement/cancel. Pertahankan total kewajiban dan hak setiap pemilik tanpa pembayaran ganda. Akun yang menjadi agen sekaligus pembeli tetap dapat memiliki dua jenis hak dana.

`withdraw` memakai saldo pemilik, request/nonce unik, serta status pending sebelum membuat transfer. Callback privat mengonfirmasi transfer sukses atau memulihkan hak jika transfer gagal. Callback harus O(1), memakai storage yang sudah disediakan dan gas yang diukur. Jika callback sendiri gagal, record pending tidak boleh dianggap sukses atau diulang membabi buta; pertahankan journal untuk pemeriksaan receipt dan pemulihan yang tidak membayar dua kali.

Pisahkan escrow aktif, claimable, pending transfer, dan dana yang sudah diterima dalam pembukuan. Settlement/pembatalan tidak boleh diulang untuk menciptakan kredit baru. Dana storage operator tidak masuk metrik laba wagering. Runner otomatis mencairkan hak agen, sementara dashboard menyediakan pencairan bagi pembeli.

## 7. Sumber dan definisi outcome

### Harga

Instrumen adalah Binance spot `NEARUSDT`, interval candle `1h`, UTC. Outcome YES jika harga close candle selesai lebih besar dari open; sama atau turun adalah NO. Bandingkan representasi desimal eksak, bukan float yang dapat mengubah kasus seri.

Gunakan candle periode target yang sudah selesai; simpan respons sumber dan timestamp/instrumennya. Tidak ada fallback diam-diam ke CoinGecko, USD, USDC, atau harga live parsial. Jika data lengkap tidak tersedia sampai deadline, batalkan melalui timeout.

### Presipitasi

Outcome YES jika `precipitation_sum >= 1,0 mm` menurut Open-Meteo ECMWF IFS 9 km untuk titik Kudus `latitude=-6.8049`, `longitude=110.8397`, pada tanggal lokal `Asia/Jakarta`. Simpan model, request, grid yang dikembalikan, timezone, dan respons sumber yang dipakai saat resolusi. Perbandingan memakai unit presipitasi terukur yang konsisten.

Ini outcome menurut output model/grid, bukan pembacaan stasiun resmi atau kebenaran fisik yang immutable. Resolusi menggunakan satu respons lengkap yang dicatat; revisi provider sesudahnya tidak mengubah outcome yang sudah final. Jangan mengganti model/dataset ketika provider terlambat.

### Provenance dan penggunaan data

Baca [riset sumber data](docs/research/forecast-data-constraints.md). Binance/Binance Vision dan Open-Meteo memiliki ketentuan layanan/lisensi yang berbeda untuk akses dan redistribusi. Simpan atribusi dan lisensi dataset yang benar; jangan menganggap lisensi kode provider berlaku untuk data. Demo testnet bukan klaim izin produksi komersial.

## 8. Agen dan modal

Delapan identitas algoritmik, tanpa ketergantungan LLM:

| Agen | Domain | Strategi |
| --- | --- | --- |
| `meteo` | Cuaca | Run forecast presipitasi yang tersedia sebelum cutoff, dikonversi menjadi probabilitas dengan aturan tetap; tidak diklaim terkalibrasi. |
| `climatology` | Cuaca | Frekuensi kejadian historis dari input yang tersedia, bukan konstanta perkiraan yang dibuat-buat. |
| `persistence` | Keduanya | Mengutamakan pengulangan outcome terakhir yang sudah diketahui. |
| `momentum` | Harga | Kelanjutan tren harga. |
| `meanrev` | Harga | Pembalikan terhadap rerata harga sebelumnya. |
| `noisy-trend` | Keduanya | Sinyal tren dengan noise ber-seed; bukan pembacaan berita/sentimen eksternal. |
| `yolo` | Keduanya | Forecast ekstrem 0% atau 100%. |
| `coinflip` | Keduanya | Probabilitas acak ber-seed. |

Ada enam strategi relevan per domain. Spesialis tidak dipaksa mengikuti domain lain. Aturan, transformasi probabilitas, lookback, dan parameter ditetapkan sebelum evaluasi dan dicatat bersama hasil; jangan tuning pada periode uji sampai swarm menang.

Bankroll adalah total modal, termasuk stake terkunci dan hak dana belum dicairkan. Available Balance hanya dana yang bisa dialokasikan untuk taruhan baru; dana yang sudah dialokasikan tidak dipakai ulang. Sizing adalah floor 10% Available Balance; jika kurang dari minimum stake, lewatkan Round tanpa menaikkan stake ke minimum.

Di simulasi, setiap agen mulai dengan 100 NEAR, gas/storage di luar ekonomi wagering, dan modal direset antar-eksperimen domain. Live memakai saldo nyata testnet serta reserve operasional; laporkan biaya transaksi terpisah. Modal habis, saldo bebas di bawah minimum, dan modal terkunci adalah kondisi berbeda. Agen bisa aktif kembali setelah dana tersedia, bukan otomatis ditandai bangkrut permanen.

## 9. Simulasi offline dan evaluasi

`npm run sim` memakai bundel lokal, tanpa jaringan, API key, atau LLM saat replay. Periode tetap: 2026-08-01 sampai 2026-09-29 inklusif. Masing-masing domain mencakup 60 hari lengkap: 1.440 candle per jam UTC untuk harga dan 60 outcome harian WIB untuk cuaca. Warm-up tujuh hari harga dan 365 hari cuaca mendahului periode evaluasi. Seed default 42.

Bundel mencakup data outcome dan input strategi yang sah, manifest source URL/model/instrumen, timestamp validitas dan ketersediaan bila terbukti, waktu fetch, checksum, serta atribusi/lisensi. Jangan membuat forecast historis dengan mengambil outcome hari target. Null, gap, data parsial, atau input tidak tersedia harus terlihat dalam laporan, bukan diisi dengan data masa depan atau disembunyikan dengan memilih subset yang mudah.

Batas point-in-time:

- Candle harus selesai sebelum cutoff; `openTime < cutoff` tidak cukup. `closeTime` adalah akhir periode, bukan bukti waktu publikasi.
- Tanggal reanalysis yang lampau tidak membuktikan versi nilai itu tersedia sebelum cutoff; model dapat dipublikasikan terlambat atau direvisi.
- Previous Runs pada lead per jam tidak otomatis membuktikan satu vektor harian tersedia pada satu cutoff. Utamakan satu Single Run dengan initialization dan publication/availability sebelum cutoff.
- Jika availability historis tidak dapat dibuktikan, tandai inference dan keluarkan input dari klaim strict point-in-time, atau beri label eksplisit retrospective benchmark. Jangan menyatakan validasi availability yang belum diamati.

Jalankan eksperimen harga dan cuaca terpisah. Laporkan Brier error, coverage/round count setiap agen, komposisi peserta aktif, bankroll, stake terkunci, laba/rugi wagering, dan fee. Bandingkan agregat dengan individu, equal-weight baseline, serta stake-weighted baseline pada cohort/round sepadan; nyatakan exclusion dan denominator. Log-odds boleh menjadi pembanding berlabel dengan clipping eksplisit, bukan mengganti produk utama.

JSON summary dan tabel terminal harus reproducible untuk bundel/config/seed sama. Nilai error yang lebih kecil lebih baik; reward score yang lebih besar lebih baik. Tidak ada acceptance criterion bahwa swarm wajib menang. Hasil buruk tetap hasil sah bila data dan accounting benar.

## 10. Arsitektur yang akan dibuat

Rust `near-sdk = "5.5.0"`, target `wasm32-unknown-unknown`; Node/TypeScript dengan npm workspaces untuk runner, simulasi, dan dashboard. Pilihan dashboard: Vite + React + TypeScript + Tailwind + Lucide, bukan Next.js/SSR.

| Path rencana | Tanggung jawab |
| --- | --- |
| `contracts/hivecast/src/lib.rs` | Lifecycle, authorization, commitment, pembelian, settlement, refund, withdrawal, dan view terpaginasikan. |
| `contracts/hivecast/src/scoring.rs` | Brier, rasio payout eksak, bounds, dan alokasi sisa. |
| `packages/simulation/src/sim.ts` | Replay dua domain dan pelaporan deterministic. |
| `packages/simulation/data/` | Bundel historis, warm-up, input forecast, dan manifest provenance/lisensi. |
| `packages/runner/src/index.ts` | Pembuatan Question, strategi, transaksi, resolusi, reveal, settlement, dan pencairan agen. |
| `packages/runner/` | SQLite privat untuk forecast/salt/snapshot, reservation modal, dan journal transaksi; endpoint akses terautentikasi. |
| `packages/dashboard/src/App.tsx` | Leaderboard, detail Round, perbandingan error, pembelian snapshot, dan pencairan. |

Runner menyimpan forecast/salt sebelum commit dan tidak membuat salt baru setelah restart. Reconcile journal dengan chain, termasuk transaksi pending, sebelum mengirim tindakan lagi. Snapshot dibekukan dan disimpan durable. Signing keys/database tidak masuk Git, frontend, public log, atau fixture demo publik. Gunakan akun agen yang terpisah, tetapi jelaskan bahwa operator yang sama mengendalikan layanan.

API kontrak yang direncanakan: initialization dengan operator; `create_question` dengan specification lengkap; `commit`; operator-only snapshot-readiness publication; `buy_forecast`; resolver-only `resolve`; `reveal`; permissionless `settle` dan `cancel` dengan prasyarat; klaim refund per pemilik; `withdraw` dan callback privat; `get_question`, `has_bought`, claim/pending views, serta list/leaderboard terpaginasikan. Bukan interface lama yang hanya menerima dua timestamp dan langsung push semua payout.

Semua dana/big integer melewati JSON sebagai string desimal; TypeScript tidak menggunakan `number` untuk yoctoNEAR atau timestamp nanodetik. Pisahkan network/contract ID di konfigurasi dan transaksi; receipt dari network/contract lain tidak membuka akses.

Dashboard membedakan live testnet, sandbox, dan simulasi. Tampilkan sumber outcome, countdown, jumlah peserta, single-agent marker, commitment/reveal, forecast yang memang sudah publik, payout versus claimable/pending/received, bankroll dan modal terkunci, fee versus biaya gas, coverage, serta link explorer transaksi live. Jangan menampilkan chart yang mengasumsikan swarm selalu menang.

## 11. Verification dan acceptance criteria implementasi

Bagian ini adalah pemeriksaan yang WAJIB dijalankan setelah implementasi, bukan hasil yang sudah diperoleh.

### Kontrak dan accounting

- Build WASM nyata dan jalankan `cargo test --manifest-path contracts/hivecast/Cargo.toml`; keberadaan toolchain saja bukan bukti kompatibilitas SDK/build.
- Uji probability 0/10000, outcome keduanya, skor ekstrem/seri, stake timpang, plafon dana, dan overflow rejection.
- Buktikan konservasi stake dan fee/refund dengan pembulatan, tie-break, non-reveal parsial/total, valid score nol, dan satu peserta.
- Uji satu commit final, hash yang disalin lintas akun/Question/kontrak, nominal stake berbeda, salt/probability salah, dan reveal duplikat.
- Exercise tepat sebelum/pada/setelah setiap deadline; resolved/cancelled/settled tidak dapat diulang atau ditukar.
- Uji izin create/resolve/readiness/callback, perubahan aturan lewat API yang ditolak, pembelian salah harga/duplikat/terlambat/snapshot belum siap, dan cadangan storage tidak cukup.
- Buktikan sponsor storage tidak mengambil dana pengguna; refund agen dan pembeli tidak memerlukan scan seluruh pembeli.
- Uji claim/withdraw duplikat, transfer gagal, pending request, dan callback restriction; amati saldo penerima, bukan event payout saja.
- Ukur gas settlement 64 peserta pada sandbox/testnet; views/list harus bounded.

### Simulasi

- `npm run sim` benar-benar berjalan offline dari bundel lengkap dan config tetap, tanpa network atau LLM.
- Coverage data sesuai 60 hari setiap domain beserta warm-up; semua missing/availability inference dinyatakan.
- Seed sama menghasilkan output identik; accounting tetap konservatif pada seluruh replay.
- Bandingkan metric pada cohort dan denominator yang dinyatakan; tidak menguji kemenangan swarm sebagai invariant.

### Runner dan testnet

- Sandbox nyata menguji happy path, timeout cancellation, nol reveal, dan pemulihan runner setelah restart; mock output bukan bukti eksekusi chain.
- Setidaknya satu Round NEAR testnet nyata melewati commit, freeze snapshot, buy, observasi, resolve, reveal, settle, dan withdrawal sampai saldo penerima bertambah. Simpan transaction/receipt references.
- Buktikan wallet pemilik receipt mendapat snapshot yang sama saat retry; akun lain, bukti network salah, dan replay challenge tidak membuka akses.
- Exercise gangguan delivery tanpa pembelian ulang dan tanpa mengklaim refund otomatis yang tidak disediakan.

### Dashboard

- Jalankan aplikasi, hubungkan wallet testnet, beli dan baca snapshot, buka detail Round, serta lakukan pencairan.
- Amati state pending/final dan error aktual pada surface; build saja tidak membuktikan perilaku UI.
- Verifikasi sumber data/mode jelas, rahasia tidak bocor ke public payload, dan chart/leaderboard tidak mengubah hasil eksperimen.

## 12. Bukti tahap desain

Pada tahap grill, glossary dan dua ADR sudah ditulis. Dua catatan riset menggunakan sumber primer dan public read-only probes: [NEAR constraints](docs/research/near-contract-constraints.md) dan [data constraints](docs/research/forecast-data-constraints.md). Bagian pilihan terbuka pada catatan riset adalah konteks riset; keputusan produk final mengikuti rencana ini.

Prototipe aritmetika rasional telah memeriksa contoh distorsi insentif fee berbobot skor, 144 kombinasi awal konservasi payout, dan 512 kasus ber-seed dengan 1–64 peserta serta nilai dana besar. Pemeriksaan terakhir mencakup non-negativitas payout dasar, konservasi stake dan fee/refund, nol fee untuk non-revealer, refund saat nol reveal valid, serta batas U256. Periode tanggal juga telah diperiksa sebagai 60 hari dan 1.440 interval per jam UTC. Itu bukan test kontrak, bukti build, pengukuran gas, atau bukti dataset tersedia lengkap. Belum ada implementasi, bundel data, smoke test aplikasi, atau transaksi demo pada tahap sinkronisasi dokumen ini.
