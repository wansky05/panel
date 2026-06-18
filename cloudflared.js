const config = require('./config.js');
// 1. Cek apakah tunnel diizinkan
if (config.tunnel !== true) {
  console.log("ℹ️ Cloudflare Tunnel dinonaktifkan di config.");
  return; // Berhenti di sini, jangan jalankan kode di bawahnya
}

// 2. Ambil token dan bersihkan spasi
const token = config.cftoken ? config.cftoken.trim() : "";

// 3. Cek apakah token valid (tidak kosong setelah di-trim)
if (!token || token.length === 0) {
  console.error("❌ Error: Tunnel aktif tapi cftoken kosong atau hanya berisi spasi!");
  return; // Berhenti di sini
}

// 4. Jika lolos semua cek, jalankan logika utama
console.log("🚀 Menjalankan Cloudflare Tunnel...");

const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const APP_PORT = 3000 || process.env.SERVER_PORT;

const CLOUDFLARED_BIN = "cloudflared";
const CLOUDFLARED_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64";

// Fungsi download dengan support redirect
function downloadFile(fileUrl, output, cb) {
  const options = new URL(fileUrl);

  https.get(options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return downloadFile(res.headers.location, output, cb);
    }

    if (res.statusCode !== 200) {
      console.error("[ERROR] Gagal download, status code:", res.statusCode);
      process.exit(1);
    }

    const file = fs.createWriteStream(output);
    res.pipe(file);

    file.on("finish", () => {
      file.close(() => cb());
    });
  }).on("error", (err) => {
    console.error("[ERROR] Download error:", err.message);
    process.exit(1);
  });
}

// Fungsi download cloudflared kalau belum ada
function downloadCloudflared(cb) {
  if (fs.existsSync(CLOUDFLARED_BIN)) {
    return cb();
  }
  console.log("[INFO] Mengunduh cloudflared...");
  downloadFile(CLOUDFLARED_URL, CLOUDFLARED_BIN, () => {
    fs.chmodSync(CLOUDFLARED_BIN, 0o755);
    console.log("[INFO] cloudflared berhasil diunduh ✅");
    cb();
  });
}

function checkLine(text) {
  // Tangkap konfigurasi dan ambil hostname
  if (text.includes('ingress')) {
    let match = text.split(':[')

    if (match.length > 1) {
      try {
        match = JSON.parse(
          match[1].split(', {')[0].replace(/\\/g, '')
        )
      } catch (e) {
        try {
          match = JSON.parse(
            match[1].split(',{')[0].replace(/\\/g, '')
          )
        } catch (err) {
          match = null
        }
      }

    }
    if (typeof match === 'string') {
      //match = match.replace(/\\/g,'')
      //let hostname = (JSON.parse(match)).hostname
      let hostname = match.hostname
      console.log(`[INFO] Web Sudah Online https://${hostname}`);
    }
  }
  // Tangkap lokasi koneksi tunnel
  const tunnelRegex = /Registered tunnel connection.*location=([a-z0-9]+)/;
  const tunnelMatch = text.match(tunnelRegex);
  if (tunnelMatch) {
    const location = tunnelMatch[1];
    const message = `[SUCCESS] Tunnel aktif di lokasi: ${location}`
    console.log(message);
  }

}

// Fungsi jalankan cloudflared (ambil link dari stdout + stderr)
function runCloudflared() {
  const cloudflared = spawn(CLOUDFLARED_BIN, [
    "tunnel",
    "run",
    "--token",
    config.cftoken
  ]);

  cloudflared.stdout.on("data", (data) => {
    // console.log(data.toString());
    checkLine(data.toString());
  });

  cloudflared.stderr.on("data", (data) => {
    //console.log(data.toString());
    checkLine(data.toString());
  });
}

// Jalankan aplikasi Node.js sederhana
function runApp() {
  const http = require("http");
  const server = http.createServer((req, res) => {
    res.end("Halo dari aplikasi Node.js (port 80) + Cloudflared!");
  });

  server.listen(APP_PORT, () => {
    console.log(`[INFO] Aplikasi Node.js jalan di http://localhost:${APP_PORT}`);
  });
}
// Main
downloadCloudflared(() => {
//runApp();
  runCloudflared();
});
