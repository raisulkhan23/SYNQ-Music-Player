const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR;
  const target = path.join(asarRoot, 'dist/index.html');
  const url = require('node:url').pathToFileURL(target).href;
  const preload = path.join(asarRoot, 'electron', 'preload.cjs');
  const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const logs = [];
  w.webContents.on('console-message', (_e, level, message, line, src) => { logs.push('L' + level + ': ' + (message||'').slice(0, 300) + ' @ ' + (src||'').split(/[\/]/).pop() + ':' + line); });
  w.webContents.on('render-process-gone', (_e, d) => console.log('RENDER-GONE', d.reason, d.exitCode));
  w.webContents.on('preload-error', (_e, p, err) => console.log('PRELOAD-ERROR', p, err && err.message));
  w.webContents.on('did-fail-load', (_e, code, desc, u) => console.log('DID-FAIL-LOAD', code, desc, u));
  w.webContents.on('did-finish-load', () => console.log('DID-FINISH-LOAD'));
  w.webContents.on('page-title-updated', (_e, t) => console.log('TITLE→', t));
  await w.loadURL(url);
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const snap = await w.webContents.executeJavaScript(`({
      rc: document.getElementById('root')?.childElementCount,
      text: (document.body?.innerText||'').slice(0,200).replace(/\n/g,' | '),
      ready: document.readyState,
    })`).catch(e => ({ err: e.message }));
    console.log('t+' + (i*3+3) + 's', JSON.stringify(snap));
  }
  console.log('--- console ---');
  logs.forEach(l => console.log(l));
  app.exit(0);
});
