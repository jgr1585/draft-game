'use strict';
// Startet einen Testserver mit schnellen Rädern und spielt ein ganzes Spiel durch.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Räder landen in einem Temp-Ordner, damit der Test die echte wheels.json nicht überschreibt
const WHEEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auktion-wheels-'));
const env = { ...process.env, PORT: '3999', SPIN_MS: '60', WHEEL_DIR };
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
setTimeout(() => {
  const sim = spawn(process.execPath, [path.join(__dirname, 'simulate.js')], { env, stdio: 'inherit' });
  sim.on('exit', (code) => { srv.kill(); process.exit(code); });
}, 1200);
