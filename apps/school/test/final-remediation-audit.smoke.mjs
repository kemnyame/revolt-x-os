import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){return readFile(new URL('../dist/'+name,import.meta.url),'utf8')}

test('submitted records use the successful green status family',async()=>{
  const ui=await read('ui.js');
  assert.match(ui,/released\|submitted\/\.test\(n\)\)c=' success'/);
});

test('HR payroll supports staff-specific component overrides and full payslip details',async()=>{
  const ui=await read('ui.js');
  assert.match(ui,/data-pay-component-override/);
  assert.match(await read('workflow-ui.js'),/Earnings & deductions/);
  assert.match(ui,/valueOverride/);
  assert.match(ui,/rateOverride/);
});

test('current Ghana PAYE automation and SSNIT-aware chargeable income are wired',async()=>{
  const payroll=await read('hr-payroll-routes.js');
  assert.match(payroll,/ghanaMonthlyPaye2026/);
  assert.match(payroll,/\[588,\s*0\]/);
  assert.match(payroll,/\[30332,\s*\.30\]/);
  assert.match(payroll,/remaining\s*>\s*0/);
  assert.match(payroll,/remaining\s*\*\s*\.35/);
  assert.match(payroll,/employeeSsnit/);
  assert.match(payroll,/year\s*===\s*2026\s*&&\s*month\s*>=\s*9/);
});

test('locked academic periods protect direct resource mutation routes',async()=>{
  const server=await read('server.js');
  assert.match(server,/directAcademicLockRoutes/);
  for(const table of ['academic_years','terms','classrooms','assessments','homework_assignments','lesson_notes','timetable_entries','teacher_assignments','class_subjects','enrolments']){
    assert.match(server,new RegExp(table));
  }
  assert.match(server,/closed and read-only/);
});
