const config = require('./config.js')
if (config.tunnel === true && typeof config.cftoken === 'string' && config.cftoken.length > 0) {
  require("./cloudflared.js");
} else if (config.tunnel === true && !config.cftoken) {
  console.warn("⚠️ Tunnel diaktifkan di config, tapi cftoken kosong!");
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pm2 = require('pm2');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');
const tar = require('tar'); // Tambahkan di bagian atas server.js
const Convert = require('ansi-to-html'); // Tambahan library warna
const pty = require('node-pty');

const port = Number(config.port) || Number(process.env.PORT) || Number(process.env.SERVER_PORT) || 80;
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const convert = new Convert({ newline: true, escapeXML: true }); // Konfigurasi converter
// KONFIGURASI PATH & AUTH
const APPS_ROOT = path.join(__dirname, 'apps');
const ADMIN_USER = config.admin; 
const ADMIN_PASS = config.password; 

fs.ensureDirSync(APPS_ROOT);
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'temp/') // File disimpan di sini sementara
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname) // Tetap gunakan nama asli
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 } // Limit 200MB (opsional)
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')))

app.use(session({
    secret: config.secretkey,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// MEMORI LOG (BUFFER) - Menyimpan 100 baris terakhir per aplikasi
const logBuffer = {};

// Fungsi Helper untuk memproses log ke HTML dan mengirim ke socket
function processAndEmitLog(appName, rawMessage, type = 'out') {
    // Tambahkan warna merah jika tipe adalah error
    let message = rawMessage;
    
    // Konversi ANSI ke HTML (library convert sudah menangani newline)
    const htmlMessage = convert.toHtml(message);

    if (!logBuffer[appName]) logBuffer[appName] = [];
    
    // Tambahkan ke buffer
    logBuffer[appName].push(htmlMessage);
    
    if (logBuffer[appName].length > 100) logBuffer[appName].shift();

    // Broadcast ke user yang sedang membuka console aplikasi ini
    io.to(appName).emit('log-data', htmlMessage);
}

// KONEKSI PM2
pm2.connect((err) => {
    if (err) {
        console.error("PM2 Connect Error");
        process.exit(2);
    }
    console.log("PM2 Connected.");

    // MONITOR LOG DARI PM2 BUS
   // 1. Taruh di LUAR listener bus.on
const lastActionStore = {};
    pm2.launchBus((err, bus) => {
        if (err) return;

        bus.on('log:out', (data) => {
            const appName = data.process.name;
            // Gunakan fungsi pembantu agar log dikonversi ke HTML & masuk buffer
            processAndEmitLog(appName, data.data, 'out');
        });

        bus.on('log:err', (data) => {
            const appName = data.process.name;
            // Gunakan fungsi pembantu untuk log error
            processAndEmitLog(appName, data.data, 'err');
        });
        // 2. Pantau Perubahan Status (Start, Restart, Stop, Delete)
    bus.on('process:event', (data) => {
        const appName = data.process.name;
        const action = data.event;
        const trackedEvents = ['start', 'restart', 'stop', 'exit'];

        if (trackedEvents.includes(action)) {
            // 2. Cek apakah action yang baru sama dengan action sebelumnya untuk app ini
            if (lastActionStore[appName] === action) {
                return; // Berhenti di sini (abaikan duplikat)
            }

            // 3. Simpan action terbaru ke dalam store
            lastActionStore[appName] = action;

            const cleanName = appName.replace(/_/g, ' ').toUpperCase();
            const statusMessage = `${cleanName} is ${action.toUpperCase()}`;
            
            //processAndEmitLog(appName, statusMessage, 'system');
            processAndEmitLog(appName, `\x1b[33m[SYSTEM] ${statusMessage.trim()}\x1b[0m`,'system');
        }
    });
    });
});

// MIDDLEWARE AUTH
const checkAuth = (req, res, next) => {
    if (req.session.loggedIn) next();
    else res.redirect('/login');
};

// --- ROUTES HALAMAN (VIEWS) ---
app.get('/', (req, res) => res.redirect('/home'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/home', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'home.html')));
app.get('/dashboard/:name/console', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'console.html')));
app.get('/dashboard/:name/files', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'filemanager.html')));
app.get('/dashboard/:name/settings', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'settings.html')));
app.get('/dashboard/:name/terminal', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'terminal.html')));

// --- API LOGS HISTORY ---
app.get('/api/apps/logs/:name', checkAuth, (req, res) => {
    const appName = req.params.name;
    res.json({ logs: logBuffer[appName] || [] });
});

// --- API AUTH ---
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
});

// --- API APPS CREATE ---
app.post('/api/apps/create', checkAuth, (req, res) => {
    const { name } = req.body;
    const folderName = name.replace(/[^a-z0-9-]/gi, '_').toLowerCase();
    const targetDir = path.join(APPS_ROOT, folderName);
    if (fs.existsSync(targetDir)) return res.status(400).json({ error: "Folder aplikasi sudah ada!" });
    try {
        fs.mkdirSync(targetDir);
        fs.writeFileSync(path.join(targetDir, 'index.js'), '// Start your code here\nconsole.log("App Running...");');
        res.json({ success: true, name: folderName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Install Dependencies
app.post('/api/apps/install', checkAuth, (req, res) => {
    const { name } = req.body;
    const appDir = path.join(APPS_ROOT, name);

    if (!fs.existsSync(path.join(appDir, 'package.json'))) {
        return res.status(400).json({ error: "package.json tidak ditemukan!" });
    }

    res.json({ success: true, message: "Instalasi dimulai..." });

    processAndEmitLog(name, `\n\x1b[33m[SYSTEM]\x1b[0m Memulai npm install di /apps/${name}...\n`);

    const child = exec('npm install --force', { cwd: appDir });

    child.stdout.on('data', (data) => processAndEmitLog(name, `\x1b[32m[STDOUT]\x1b[0m ${data}`));
    child.stderr.on('data', (data) => processAndEmitLog(name, `\x1b[31m[STDERR]\x1b[0m ${data}`));

    child.on('close', (code) => {
        const msg = code === 0 ? "Selesai dengan sukses!" : "Gagal dengan kode: " + code;
        processAndEmitLog(name, `\n\x1b[36m[SYSTEM]\x1b[0m ${msg}\n`);
    });
});

// --- API LIST APPS ---
app.get('/api/apps', checkAuth, async (req, res) => {
    pm2.list(async (err, list) => {
        try {
            const folders = await fs.readdir(APPS_ROOT);
            const appList = await Promise.all(folders.map(async (folder) => {
                const folderPath = path.join(APPS_ROOT, folder);
                if (!(await fs.stat(folderPath)).isDirectory()) return null;
                const proc = list.find(p => p.name === folder);
                return {
                    name: folder,
                    status: proc ? proc.pm2_env.status : 'stopped',
                    cpu: proc ? proc.monit.cpu : 0,
                    memory: proc ? (proc.monit.memory / 1024 / 1024).toFixed(2) + ' MB' : '0 MB'
                };
            }));
            res.json(appList.filter(a => a !== null));
        } catch (e) { res.json([]); }
    });
});

// --- API CONTROL (START/STOP/RESTART) ---
app.post('/api/control', checkAuth, (req, res) => {
  const { action, name } = req.body;
  const appDir = path.join(APPS_ROOT, name);
  const configPath = path.join(appDir, '.xixypanelconfig');

  const startFromConfig = () => {
    // 1. Cek keberadaan file config
    if (!fs.existsSync(configPath)) {
      return res.status(400).json({ error: "Entry Point belum ditentukan. Silakan ke Settings." });
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const scriptPath = path.join(appDir, config.main);

      // 2. CEK FISIK FILE (PENTING!)
      // Kita cek di sini agar tidak dapet error 'undefined' dari PM2
      if (!fs.existsSync(scriptPath)) {
        return res.status(404).json({
          error: `File "${config.main}" tidak ditemukan di folder /apps/${name}. Silakan upload file tersebut atau ubah Entry Point di Settings.`
        });
      }

      // 3. Bersihkan proses lama & Start baru
      pm2.delete(name, (deleteErr) => {
        // Kita abaikan deleteErr karena bisa jadi app memang sedang mati
        pm2.start({
          name: name,
          script: scriptPath,
          cwd: appDir,
          autorestart: true
        }, (err) => {
          // Cek jika ada error dari PM2
          if (err) {
            console.error("PM2 Start Error:", err);
            return res.status(500).json({ error: err.message || "Terjadi kesalahan pada PM2 saat menjalankan aplikasi." });
          }

          // Simpan state dan beri respon sukses
          pm2.dump(() => res.json({
            status: "ok",
            message: `Aplikasi berhasil dijalankan menggunakan: ${config.main}`
          }));
        });
      });
    } catch (e) {
      console.error("JSON Parse Error:", e);
      res.status(500).json({ error: "File .xixypanelconfig rusak. Silakan simpan ulang di Settings." });
    }
  };

  if (action === 'start' || action === 'restart') {
    startFromConfig();
  }
  else if (typeof pm2[action] === 'function') {
    pm2[action](name, (err) => {
      if (err) return res.status(500).json({ error: `Gagal memproses ${action}: ${err.message || 'Error tidak diketahui'}` });
      pm2.dump(() => res.json({ status: "ok" }));
    });
  }
  else {
    res.status(400).json({ error: "Aksi tidak valid atau tidak didukung." });
  }
});

// --- API SETTINGS ---
app.post('/api/apps/update-settings', checkAuth, (req, res) => {
  const { name, mainFile } = req.body;
  const appDir = path.join(APPS_ROOT, name);
  const configPath = path.join(appDir, '.xixypanelconfig');

  // 1. LANGSUNG DELETE proses di PM2 tanpa tapi-tapi
  // Ini memastikan proses lama mati total sebelum identitas barunya disimpan
  pm2.delete(name, (err) => {
    // Kita abaikan jika err (misal app memang sudah mati), yang penting bersih.

    // 2. PAKSA BUAT / TIMPA file config
    // Tidak ada pengecekan fs.existsSync(scriptPath) di sini sesuai permintaanmu
    const configData = {
      main: mainFile,
      updatedAt: new Date().toISOString()
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');

      // 3. Simpan state PM2 (dump)
      pm2.dump(() => {
        res.json({
          success: true,
          message: "Config dipaksa update & proses lama dihapus. Pastikan file entry point tersedia sebelum Start!"
        });
      });
    } catch (writeErr) {
      console.error("Gagal paksa tulis config:", writeErr);
      res.status(500).json({ error: "Gagal menulis file konfigurasi." });
    }
  });
});

app.post('/api/apps/delete', checkAuth, async (req, res) => {
    const { name } = req.body;
    pm2.delete(name, async () => {
        await fs.remove(path.join(APPS_ROOT, name));
        pm2.dump(() => res.json({ message: "Deleted" }));
    });
});

// --- API FILE MANAGER ---
app.get('/api/files', (req, res) => {
  try {
    const appName = req.query.appName;
    const subDir = req.query.dir || ""; // Default kosong jika di root

    if (!appName) {
      return res.status(400).json({ error: "appName is required" });
    }

    // 1. Tentukan Root Path (Folder Induk)
    // Pastikan folder 'containers' ini benar-benar ada di direktori server kamu
    const rootPath = path.resolve(__dirname, 'apps', appName);

    // 2. Tentukan Target Path (Root + Subfolder)
    const targetPath = path.join(rootPath, subDir);

    // 3. Keamanan: Cegah Path Traversal (biar user gak bisa akses folder sistem)
    if (!targetPath.startsWith(rootPath)) {
      return res.status(403).json({ error: "Forbidden: Access Denied" });
    }

    // 4. Cek apakah folder tersebut ada
    if (!fs.existsSync(targetPath)) {
      return res.json([]); // Kirim array kosong jika folder tidak ditemukan
    }

    // 5. Baca Isi Folder
    fs.readdir(targetPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        console.error("Readdir Error:", err);
        return res.status(500).json({ error: "Failed to read directory" });
      }

      // 6. Map data menjadi Object (Bukan String)
      const response = files.map(file => ({
        name: file.name,
        isDirectory: file.isDirectory() // Frontend butuh ini untuk ikon dan klik
      }));

      // Urutkan: Folder di atas, File di bawah
      response.sort((a, b) => b.isDirectory - a.isDirectory);

      res.json(response);
    });
  } catch (error) {
    console.error("Server Crash:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/files/content', checkAuth, (req, res) => {
    const { appName, filePath } = req.query;
    try {
        const content = fs.readFileSync(path.join(APPS_ROOT, appName, filePath), 'utf8');
        res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/save', checkAuth, (req, res) => {
    const { appName, filePath, content } = req.body;
    try {
        fs.writeFileSync(path.join(APPS_ROOT, appName, filePath), content);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 1. UPLOAD FILE ---
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    try {
        const { appName, currentDir } = req.body;
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const appPath = path.join(__dirname, 'apps', appName, currentDir);
        const targetPath = path.join(appPath, req.file.originalname);

        // Pindahkan dari folder temp ke folder aplikasi
        fs.copyFileSync(req.file.path, targetPath);
        
        // Hapus file di folder temp setelah dicopy
        fs.unlinkSync(req.file.path); 

        res.json({ message: "Upload success" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal memindahkan file: " + err.message });
    }
});
// --- 2. ARCHIVE (ZIP) ---
app.post('/api/files/archive', (req, res) => {
    const { appName, files, zipName } = req.body;
    const appPath = path.join(__dirname, 'apps', appName);
    const zip = new AdmZip();

    try {
        files.forEach(file => {
            const filePath = path.join(appPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                zip.addLocalFolder(filePath, file);
            } else {
                zip.addLocalFile(filePath);
            }
        });
        zip.writeZip(path.join(appPath, zipName));
        res.json({ message: "Archived successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 3. UNARCHIVE (EXTRACT) ---
app.post('/api/files/unarchive', async (req, res) => {
    const { appName, filePath, outputDir } = req.body;
    const appPath = path.join(__dirname, 'apps', appName);
    const fullPath = path.join(appPath, filePath);
  const realOutputDir = path.join(__dirname, 'apps', appName, outputDir);

    // 1. Validasi keberadaan file
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: "File tidak ditemukan di server." });
    }

    try {
        const lowerPath = filePath.toLowerCase();

        if (lowerPath.endsWith('.zip')) {
            // 2. Gunakan Try-Catch internal untuk AdmZip agar error header tidak mematikan server
            try {
                const zip = new AdmZip(fullPath);
              zip.extractAllTo(realOutputDir, true); // true = overwrite
                return res.json({ message: "ZIP extracted successfully" });
            } catch (zipErr) {
                return res.status(400).json({ error: "Format ZIP rusak atau tidak valid: " + zipErr.message });
            }
        } 
        
        else if (lowerPath.endsWith('.tar.gz') || lowerPath.endsWith('.tgz')) {
            // 3. Ekstraksi Tarball
            await tar.x({ 
                file: fullPath, 
              C: realOutputDir
            });
            return res.json({ message: "TAR.GZ extracted successfully" });
        } 
        
        else {
            return res.status(400).json({ error: "Format file tidak didukung untuk ekstraksi." });
        }

    } catch (err) {
        console.error("Unarchive Error:", err);
        res.status(500).json({ error: "Terjadi kesalahan sistem: " + err.message });
    }
});

app.post('/api/files/mkdir', (req, res) => {
  const { appName, path: folderPath } = req.body;

  if (!appName || !folderPath) {
    return res.status(400).json({ error: "Data tidak lengkap" });
  }

  const rootPath = path.resolve(__dirname, 'apps', appName);
  const targetPath = path.join(rootPath, folderPath);

  // Keamanan: Cek Path Traversal
  if (!targetPath.startsWith(rootPath)) {
    return res.status(403).json({ error: "Akses ditolak" });
  }

  try {
    if (fs.existsSync(targetPath)) {
      return res.status(400).json({ error: "Folder sudah ada" });
    }

    // Membuat direktori
    fs.mkdirSync(targetPath, { recursive: true });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Gagal membuat folder di server" });
  }
});

// --- 4. RENAME FILE/FOLDER ---
app.post('/api/files/rename', (req, res) => {
    const { appName, oldPath, newPath } = req.body;
    const appDir = path.join(__dirname, 'apps', appName);
    const realOldPath = path.join(__dirname, 'apps', appName, oldPath);
  const realPath = appName === realOldPath ? appDir : realOldPath.split("/").slice(0, -1).join("/");

    
    try {
        fs.renameSync(path.join(appDir, oldPath), path.join(realPath, newPath));
        res.json({ message: "Renamed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 5. DELETE FILE/FOLDER ---
app.post('/api/files/delete', (req, res) => {
    const { appName, filePath } = req.body;
    const fullPath = path.join(__dirname, 'apps', appName, filePath);

    try {
        if (fs.statSync(fullPath).isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fullPath);
        }
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files/download', checkAuth, (req, res) => {
    const { appName, filePath } = req.query;
    res.download(path.join(APPS_ROOT, appName, filePath));
});

// --- SOCKET.IO ---
// Wadah untuk menyimpan sesi terminal PTY aktif agar tidak hilang saat pindah tab
const ptySessions = {};
const terminalWatchers = {}; // Melacak jumlah user yang buka terminal per app
const cleanupTimers = {}; 

io.on('connection', (socket) => {
  let currentAppPath = null;

  // Join Room Aplikasi
  socket.on('join-app', (appName) => {
    socket.join(appName);
    currentAppPath = appName;

    // --- UPDATE: BATALKAN PEMBERSIHAN JIKA ADA ---
    if (cleanupTimers[appName]) {
      clearTimeout(cleanupTimers[appName]);
      delete cleanupTimers[appName];
      console.log(`[CLEANUP] Aborted for ${appName} (User reconnected)`);
    }

    // Tambah jumlah penonton di room ini
    terminalWatchers[appName] = (terminalWatchers[appName] || 0) + 1;
    console.log(`[TERMINAL] User joined ${appName}. Watchers: ${terminalWatchers[appName]}`);
  });

  // Inisialisasi Terminal PTY
  socket.on('init-terminal', (appName) => {
    const appDir = path.join(APPS_ROOT, appName);

    if (!ptySessions[appName]) {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 100,
        rows: 30,
        cwd: appDir,
        env: { ...process.env, LANG: 'en_US.UTF-8' }
      });

      ptyProcess.onData((data) => {
        io.to(appName).emit('terminal-output', data);
      });

      ptyProcess.onExit(() => {
        console.log(`[TERMINAL] Process exited for ${appName}`);
        delete ptySessions[appName];
        // Hapus juga watcher & timer jika proses mati dari dalam (misal exit command)
        delete terminalWatchers[appName];
        if (cleanupTimers[appName]) {
            clearTimeout(cleanupTimers[appName]);
            delete cleanupTimers[appName];
        }
      });

      ptySessions[appName] = ptyProcess;

    }
  });

  // Handle Input & Shortcut
  socket.on('terminal-input', ({ appName, input }) => {
    if (ptySessions[appName]) {
      ptySessions[appName].write(input);
    }
  });

  // Handle Resize
  socket.on('terminal-resize', ({ appName, cols, rows }) => {
    if (ptySessions[appName]) {
      try {
        ptySessions[appName].resize(cols, rows);
      } catch (e) {
        console.error("Resize error:", e);
      }
    }
  });

  // Logika ANTI-GANTUNG (Updated with Timer Tracking)
  socket.on('disconnect', () => {
    if (currentAppPath && typeof terminalWatchers[currentAppPath] !== 'undefined') {
      terminalWatchers[currentAppPath]--;

      const appToCleanup = currentAppPath;

      // Tunggu 30 detik (antisipasi refresh)
      if (terminalWatchers[appToCleanup] <= 0) {
        // Simpan timer agar bisa di-clear di 'join-app'
        cleanupTimers[appToCleanup] = setTimeout(() => {
          if ((terminalWatchers[appToCleanup] || 0) <= 0 && ptySessions[appToCleanup]) {
            console.log(`[CLEANUP] Killing idle terminal session for: ${appToCleanup}`);
            try {
              // SIGKILL memastikan proses benar-benar mati
              ptySessions[appToCleanup].kill('SIGKILL');
            } catch (err) { }
            
            delete ptySessions[appToCleanup];
            delete terminalWatchers[appToCleanup]; // Bersihkan RAM
            delete cleanupTimers[appToCleanup];    // Bersihkan RAM
          }
        }, 30000);
      }
    }
  });
});

// Resource Monitor (CPU/RAM)
setInterval(() => {
    pm2.list((err, list) => {
        if (err) {
            console.error(err);
            return;
        }

        list.forEach(p => {
            // HANYA kirim update jika status aplikasi sedang 'online'
            if (p.pm2_env && p.pm2_env.status === 'online') {
                io.to(p.name).emit('resource-update', {
                    cpu: p.monit.cpu,
                    memory: (p.monit.memory / 1024 / 1024).toFixed(2) + ' MB',
                    uptime: Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000)
                });
            }
        });
    });
}, 2000);

// Jalankan Server dengan Error Handling
server.listen(port, () => {
    console.log('-----------------------------------');
    console.log('🚀 Xixy Panel Active');
    console.log(`📍 Port: ${port}`);
    console.log('-----------------------------------');
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Error: Port ${port} sudah digunakan oleh aplikasi lain!`);
        console.error(`💡 Solusi: Ubah port di config.js atau matikan aplikasi yang menggunakan port tersebut.`);
        process.exit(1); // Matikan proses dengan kode error
    } else {
        console.error(`❌ Terjadi kesalahan server:`, err.message);
    }
});