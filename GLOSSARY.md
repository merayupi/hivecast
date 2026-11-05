# HiveCast

HiveCast menyelenggarakan kompetisi forecast ber-stake untuk pertanyaan biner dan menjual akses awal ke forecast agregat.

## Language

**Forecast Wagering**:
Kompetisi tempat agen mempertaruhkan stake pada forecast probabilitas dan menerima payout berdasarkan skor relatif terhadap peserta lain.
_Avoid_: Perdagangan saham outcome, prediction market berbasis perdagangan

**Question**:
Pertanyaan mengenai satu kejadian dunia nyata yang bertanggal, memiliki dua kemungkinan outcome, dan menjadi subjek tepat satu Round.

**Round**:
Satu-satunya siklus kompetisi forecast wagering untuk sebuah Question, bukan kompetisi berulang di bawah Question yang sama.

**Aggregated Forecast**:
Rata-rata probabilitas forecast para agen, dibobot dengan stake masing-masing pada Round yang bersangkutan.
_Avoid_: Outcome, hasil resolusi

**Forecast Access**:
Hak untuk memperoleh forecast agregat sebelum outcome diketahui; bukan kepemilikan eksklusif atau jaminan kerahasiaan permanen.
_Avoid_: Pembelian outcome, forecast eksklusif

**Operator**:
Pihak yang dipercaya menjaga kerahasiaan forecast sebelum pengungkapan dan menentukan outcome melalui proses resolusi.

**Stake**:
Dana yang dipertaruhkan oleh agen untuk satu Round dan menjadi bobot kontribusi forecast serta dasar perhitungan payout.

**Commitment**:
Janji final seorang agen terhadap satu forecast dan stake untuk sebuah Question, sebelum probabilitas forecast tersebut diungkapkan.
_Avoid_: Forecast yang sudah terungkap

**Reveal**:
Pengungkapan forecast yang cocok dengan Commitment agen setelah outcome diresolusikan.

**Cancellation**:
Pengakhiran Round tanpa penilaian forecast, dengan pengembalian seluruh stake dan fee pembelian kepada pemiliknya.
_Avoid_: Settlement, outcome negatif

**Single-agent Forecast**:
Forecast untuk sebuah Round yang hanya memiliki satu agen peserta, sehingga tidak mewakili gabungan penilaian beberapa agen.
_Avoid_: Swarm forecast, konsensus multiagen

**Forecast Snapshot**:
Forecast agregat final sebuah Round yang mencakup seluruh forecast peserta saat commitment ditutup dan tidak berubah setelah pembelian.
_Avoid_: Forecast berjalan, outcome

**Agent**:
Peserta yang menghasilkan forecast dan menjalankan keputusan taruhan secara otomatis menurut strategi algoritmiknya.
_Avoid_: Model LLM independen, penilai manusia independen

**Bankroll**:
Total modal milik agen, termasuk dana yang masih terkunci dalam Round dan hak penerimaan dana yang belum dicairkan.
_Avoid_: Saldo bebas, laba

**Available Balance**:
Bagian modal agen yang saat ini dapat dialokasikan untuk stake baru, tidak termasuk dana terkunci atau yang sudah dialokasikan.
_Avoid_: Bankroll, modal total

**Claimable Balance**:
Dana yang sudah menjadi hak agen atau pembeli setelah settlement atau refund, tetapi belum dicairkan kepada pemiliknya.
_Avoid_: Dana sudah diterima, stake aktif

**Outcome**:
Jawaban biner final yang ditetapkan melalui resolusi berdasarkan kondisi kejadian dan sumber yang telah ditentukan untuk Question.
_Avoid_: Forecast, skor

**Settlement**:
Penetapan akhir payout dan refund sebuah Round berdasarkan outcome serta reveal yang valid; bukan bukti bahwa dana sudah diterima pemiliknya.
_Avoid_: Withdrawal, transfer selesai

**Valid Revealer**:
Agen yang mengungkapkan forecast sesuai Commitment dan memenuhi syarat reveal sebuah Round dalam waktunya.

**Query Fee**:
Biaya pembelian Forecast Access yang dibagikan kepada Valid Revealer menurut stake, atau dikembalikan kepada pembeli ketika Round dibatalkan atau tidak memiliki reveal valid.
_Avoid_: Stake agen, biaya gas
