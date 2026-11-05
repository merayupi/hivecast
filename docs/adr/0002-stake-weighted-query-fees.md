# Query fee berbobot stake, bukan skor

Query Fee dibagi proporsional terhadap stake di antara Valid Revealer, terpisah dari payout forecast wagering. Jika tidak ada reveal valid, seluruh fee menjadi refund pembeli. Reveal valid dengan skor nol tetap berhak atas bagian fee; tidak reveal berarti tidak berhak atas fee, meskipun payout dasar dapat mengembalikan sebagian atau seluruh stake.

Alternatif awal membagi fee menurut stake dikalikan skor. Normalisasi oleh total skor membuat fee bergantung pada probabilitas yang dilaporkan dan dapat merusak insentif jujur: dengan dua stake sama besar, forecast pembanding 50%, keyakinan sebenarnya 70%, dan pot fee sebesar satu stake, pelaporan 68% menghasilkan ekspektasi laba gabungan lebih tinggi daripada pelaporan jujur 70%. Pembagian fee menurut stake menghilangkan ketergantungan langsung tersebut bagi peserta tetap yang melakukan reveal valid, dengan trade-off tidak memberi bonus fee tambahan untuk forecast yang lebih akurat.

Klaim proper scoring dibatasi pada mekanisme wagering dengan stake dan peserta tetap, minimal dua peserta, serta reveal valid; bukan jaminan terhadap Sybil, kolusi, pilihan partisipasi, manipulasi outcome oleh Operator, atau keputusan stake. Satu peserta tidak memiliki kompetisi wagering. Mengubah aturan fee akan mengubah distribusi dana dan insentif peserta, sehingga bukan perubahan kosmetik.
