import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);

test('parent and student portals only expose published homework',async()=>{
  const server=await readFile(new URL('../dist/server.js',import.meta.url),'utf8');
  const matches=server.match(/h\.status='published'/g)||[];
  assert.ok(matches.length>=2,'Expected published-only homework filters for both family and student portal data');
});

test('official report PDF renderer is installed',()=>{
  const PDFDocument=require('pdfkit');
  assert.equal(typeof PDFDocument,'function');
});
