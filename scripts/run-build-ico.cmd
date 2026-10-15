@echo off
cd /d "%~dp0\.."
node scripts\build-ico-fix.cjs
if errorlevel 1 exit /b 1
node -e "const fs=require('fs');const p=fs.readFileSync('public\logo.ico');if(p.length<6){console.log('ICO too small');process.exit(1)}const reserved=p.readUInt16LE(0);const type=p.readUInt16LE(2);const count=p.readUInt16LE(4);if(reserved!==0){console.log('reserved',reserved,'!=0');process.exit(1)}if(type!==1){console.log('type',type,'!=1');process.exit(1)}console.log('ok reserved=0 type=1 count='+count);for(let i=0;i<count;i++){const off=6+i*16;const wc=p[off],hc=p[off+1],ts=p[off+2],rs=p[off+3],pl=p.readUInt16LE(off+4),bp=p.readUInt16LE(off+6),sz=p.readUInt32LE(off+8),of2=p.readUInt32LE(off+12);console.log('entry',i,'size',wc+'x'+hc,'planes',pl,'bpp',bp,'dataSize',sz,'offset',of2)}"
