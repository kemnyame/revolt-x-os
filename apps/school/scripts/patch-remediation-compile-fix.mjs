import { readFile, writeFile } from 'node:fs/promises';

const serverPath=new URL('../src/server.ts',import.meta.url);
let source=await readFile(serverPath,'utf8');
source=source.replace(
  "  const path=String(request.url||'').split('?')[0];",
  "  const path=String(request.url||'').split('?')[0]||'';"
);
await writeFile(serverPath,source);
console.log('Applied remediation TypeScript strictness fix');
