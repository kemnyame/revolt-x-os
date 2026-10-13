import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {z} from 'zod';
import {schoolRecordId} from '../dist/record-id.js';
import {registerSchoolClassCatalogue} from '../dist/class-catalogue.js';
import {registerSchoolRemediationRoutes} from '../dist/school-remediation-routes.js';
import {one,maybeOne,tx} from '../dist/db.js';

const school='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const from='33333333-3333-4333-8333-333333333333',to='44444444-4444-4444-8444-444444444444';
const oldClass='b7c2c536-ec4f-a0e6-cf65-96341baf445b',newClass='d2bb965b-42ec-8610-1c3c-1ef86ed0d9fa',otherClass='55555555-5555-4555-8555-555555555555';
const studentIds=Array.from({length:6},(_,i)=>'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0'));
const pg=new PGlite(),app=Fastify();
const client={query:async(sql,params)=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client};
const authorize=async()=>({core:{organisation_id:school,id:school}});
const fail=(statusCode,message)=>Object.assign(Error(message),{statusCode});
const deps={db,config:{},authorize,one,maybeOne,tx,fail,audit:async()=>{},assignMandatoryFees:async()=>{}};
app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof z.ZodError?400:error.statusCode||500).send({error:{message:error.message}}));
registerSchoolClassCatalogue(app,deps);
registerSchoolRemediationRoutes(app,deps);

before(async()=>{
  await pg.exec(`CREATE SCHEMA revolt_x_school;SET search_path TO revolt_x_school,public;
    CREATE TABLE academic_years(id uuid PRIMARY KEY,organisation_id uuid,name text,start_date date,status text,is_locked boolean DEFAULT false,locked_at timestamptz,locked_by_os_user_id uuid);
    CREATE TABLE grade_levels(id uuid PRIMARY KEY,organisation_id uuid,name text,code text,level_order int,is_active boolean DEFAULT true);
    CREATE TABLE classrooms(id uuid PRIMARY KEY,organisation_id uuid,academic_year_id uuid,grade_level_id uuid,name text,stream text,is_active boolean DEFAULT true);
    CREATE TABLE class_subjects(id uuid DEFAULT gen_random_uuid(),classroom_id uuid,is_active boolean DEFAULT true);
    CREATE TABLE students(id uuid PRIMARY KEY,organisation_id uuid,first_name text,last_name text,admission_no text,status text DEFAULT 'active',updated_at timestamptz);
    CREATE TABLE guardians(id uuid,first_name text,last_name text);
    CREATE TABLE student_guardians(student_id uuid,guardian_id uuid,relationship text,is_primary boolean);
    CREATE TABLE enrolments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid,student_id uuid,academic_year_id uuid,classroom_id uuid,status text DEFAULT 'active',enrolled_at timestamptz DEFAULT now(),UNIQUE(student_id,academic_year_id));
    CREATE TABLE terms(id uuid,organisation_id uuid,academic_year_id uuid,status text,is_locked boolean,locked_at timestamptz,locked_by_os_user_id uuid);
    CREATE TABLE promotion_batches(id uuid DEFAULT gen_random_uuid(),organisation_id uuid,from_academic_year_id uuid,to_academic_year_id uuid,from_classroom_id uuid,processed_by_os_user_id uuid,total_students int,promoted_count int,repeated_count int,completed_count int);
    CREATE TABLE student_promotions(organisation_id uuid,student_id uuid,from_academic_year_id uuid,to_academic_year_id uuid,from_classroom_id uuid,to_classroom_id uuid,outcome text,processed_by_os_user_id uuid,academic_average numeric,terms_count int,promotion_basis text,created_at timestamptz DEFAULT now(),UNIQUE(student_id,to_academic_year_id));`);
  await client.query("INSERT INTO academic_years VALUES($1,$3,'2027/2028','2027-09-01','closed',false,NULL,NULL),($2,$3,'2028/2029','2028-09-01','active',false,NULL,NULL)",[from,to,school]);
  await client.query("INSERT INTO grade_levels(id,organisation_id,name,code,level_order) VALUES($1,$3,'Primary 1','P1',1),($2,$3,'Primary 2','P2',2)",[from,to,school]);
  await client.query("INSERT INTO classrooms(id,organisation_id,academic_year_id,grade_level_id,name) VALUES($1,$4,$5,$5,'Class 1'),($2,$4,$6,$6,'Class 1'),($3,$7,$6,$6,'Other school')",[oldClass,newClass,otherClass,school,from,to,other]);
  for(const [index,id] of studentIds.entries()){
    await client.query("INSERT INTO students(id,organisation_id,first_name,last_name,admission_no) VALUES($1,$2,'Learner',$3,$4)",[id,school,String(index+1),'FIXTURE-'+index]);
    await client.query('INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id) VALUES($1,$2,$3,$4)',[school,id,from,oldClass]);
  }
  const server=await readFile(new URL('../dist/server.js',import.meta.url),'utf8');
  const context={app,z,schoolRecordId,...deps,ensureFixedAcademicYearTerms:async()=>{},ensureRolloverClassStructure:async()=>{},academicYearPromotionEvidence:async()=>({terms:[1,2,3],threshold:50,byStudent:new Map(studentIds.map(id=>[id,{ready:true,annualAverage:75,completeTerms:3}]))})};
  for(const [start,end] of [["app.get('/api/students/:id',","app.get('/api/students/:id/360',"],["app.post('/api/promotions/batch',","app.get('/api/promotions',"]]){
    const a=server.indexOf(start),b=server.indexOf(end,a);assert.ok(a>=0&&b>a);vm.runInNewContext(server.slice(a,b),context);
  }
});
after(async()=>{await app.close();await pg.close()});

test('legacy database keys rejected by RFC validation remain usable without accepting malformed IDs',()=>{
  for(const id of [oldClass,newClass,...studentIds]){assert.equal(z.string().uuid().safeParse(id).success,false);assert.equal(schoolRecordId.parse(' '+id.toUpperCase()+' '),id)}
  for(const id of ['not-a-record','undefined','null',"x' OR true",'00000000-0000-0000-0000-00000000000z'])assert.equal(schoolRecordId.safeParse(id).success,false);
});

test('daily class lists return one current-year class instead of combining identical names from two years',async()=>{
  const response=await app.inject('/api/classes');assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().map(c=>c.id),[newClass]);assert.equal(response.json()[0].academic_year_name,'2028/2029');
});

test('explicit history and rollover can still load both years, while classes from another school stay excluded',async()=>{
  const all=await app.inject('/api/classes?includeAllYears=true');assert.deepEqual(all.json().map(c=>c.id),[newClass,oldClass]);
  const source=await app.inject('/api/classes?academicYearId='+from);assert.deepEqual(source.json().map(c=>c.id),[oldClass]);
  assert.equal((await app.inject('/api/classes?academicYearId=invalid')).statusCode,400);
});

test('student profiles open using an existing legacy record key',async()=>{
  const response=await app.inject('/api/students/'+studentIds[0]);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().id,studentIds[0]);
  assert.equal((await app.inject('/api/students/not-a-record')).statusCode,400);
});

test('invalid cross-school promotion destinations leave the current enrolment intact',async()=>{
  const response=await app.inject({method:'POST',url:'/api/promotions/manual',payload:{studentId:studentIds[0],fromAcademicYearId:from,toAcademicYearId:to,toClassroomId:otherClass,outcome:'promoted',reason:'Fixture destination check'}});
  assert.equal(response.statusCode,400,response.body);assert.equal((await client.query('SELECT status FROM enrolments WHERE student_id=$1',[studentIds[0]])).rows[0].status,'active');
});

test('six legacy student IDs and a legacy destination ID complete the actual batch-promotion route',async()=>{
  const response=await app.inject({method:'POST',url:'/api/promotions/batch',payload:{fromAcademicYearId:from,toAcademicYearId:to,fromClassroomId:oldClass,records:studentIds.map(id=>({studentId:id,toClassroomId:newClass,outcome:'promoted'}))}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().promoted,6);
  assert.equal((await client.query("SELECT count(*) count FROM enrolments WHERE academic_year_id=$1 AND classroom_id=$2 AND status='active'",[to,newClass])).rows[0].count,6);
  assert.equal((await client.query('SELECT count(*) count FROM student_promotions')).rows[0].count,6);
});

test('class uniqueness treats case and surrounding whitespace as the same class within a year',async()=>{
  await pg.exec(await readFile(new URL('../migrations/059_normalized_class_names.sql',import.meta.url),'utf8'));
  await assert.rejects(client.query("INSERT INTO classrooms(id,organisation_id,academic_year_id,grade_level_id,name) VALUES(gen_random_uuid(),$1,$2,$2,'  CLASS 1  ')",[school,to]),error=>error.code==='23505');
});
