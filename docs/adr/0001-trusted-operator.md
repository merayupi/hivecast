# Operator tepercaya untuk kerahasiaan dan resolusi

HiveCast versi hackathon mempercayai Operator untuk menjaga kerahasiaan forecast sebelum pengungkapan dan menentukan outcome melalui resolver yang ditunjuk. Kontrak memverifikasi commitment serta menghitung payout; kontrak tidak membuktikan kebenaran outcome, kerahasiaan terhadap Operator, atau ketersediaan layanan forecast.

Desain ini dipilih untuk menyederhanakan implementasi dibanding oracle independen dan agregasi yang menyembunyikan forecast dari Operator. Konsekuensinya, Operator dapat membocorkan forecast, menahan layanan, atau memasukkan outcome keliru; mengganti batas kepercayaan ini membutuhkan perubahan protokol, bukan sekadar penggantian penyedia API.

Operator juga menyimpan full-access deploy key selama pengembangan testnet. Aturan Question terkunci melalui API normal, tetapi key tersebut tetap dapat mengganti kode kontrak; immutability terhadap administrator tidak dijanjikan. Tidak melakukan upgrade ketika ada Round aktif atau kewajiban dana adalah prosedur operasional, bukan pembatasan kriptografis atas deploy key.
