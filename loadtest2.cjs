const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR;
  const fs = require('node:fs');
  const target = path.join(asarRoot, 'dist/index.html');
  console.log('target:', target, 'existsViaAsarFs:', fs.existsSync(target));
  const url = require('node:url').pathToFileURL(target).href;
  const w = new BrowserWindow({ show: false });
  let done = false;
  w.webContents.on('did-fail-load', (_e, code, desc, u) => { done = true; console.log('DID-FAIL-LOAD', code, desc, u); app.exit(7); });
  w.webContents.on('did-finish-load', async () => {
    done = true;
    console.log('DID-FINISH-LOAD url=', w.webContents.getURL());
    console.log('TITLE=', await w.webContents.executeJavaScript('document.title').catch(e => 'ERR ' + e.message));
    console.log('BODYLEN=', await w.webContents.executeJavaScript('document.body?document.body.innerHTML.length:-1').catch(e => 'ERR ' + e.message));
    console.log('HAS_SYNQ=', await w.webContents.executeJavaScript('typeof window.synq').catch(e => 'ERR ' + e.message));
    app.exit(0);
  });
  w.webContents.on('preload-error', (_e, p, err) => console.log('PRELOAD-ERROR', p, err && err.message));
  w.webContents.on('console-message', (_e, level, message, line, src) => console.log('CONSOLE', level, message, (src||'')+':'+line));
  try { await w.loadURL(url); } catch (err) { console.log('LOADURL_REJECT', err.message); if (!done) app.exit(5); }
  setTimeout(() => { if (!done) { console.log('TIMEOUT no load events'); app.exit(8); } }, 8000);
});
