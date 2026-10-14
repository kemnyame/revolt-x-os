import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createSchoolDb} from '../dist/db.js';

const config={SCHOOL_DATABASE_URL:'postgresql://fixture:fixture@localhost/fixture',DB_POOL_MAX:5};
test('School queries wait for schema initialization on every newly opened pool client',async t=>{
  const queries=[],clients=[],gates=[];
  t.mock.method(pg,'Pool',function(options){
    assert.equal(options.connectionTimeoutMillis,10000);
    return {async connect(){
      const client={query:async sql=>{queries.push(sql);if(sql.startsWith('SET search_path'))await new Promise(resolve=>gates.push(resolve));return{rows:[]}},release(){}};
      clients.push(client);return client;
    }};
  });
  const db=createSchoolDb(config),first=db.query('SELECT * FROM school_profiles');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(queries.length,1);assert.match(queries[0],/^SET search_path/);
  gates.shift()();await first;assert.equal(queries[1],'SELECT * FROM school_profiles');
  const second=db.query('SELECT * FROM school_sessions');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(queries.length,3);assert.match(queries[2],/^SET search_path/);gates.shift()();await second;
  assert.equal(clients.length,2);assert.equal(queries.at(-1),'SELECT * FROM school_sessions');
});

test('failed schema initialization discards the bad connection and a fresh connection recovers',async t=>{
  let acquired=0;const released=[],queries=[],failure=Error('Connection reset during initialization');
  t.mock.method(pg,'Pool',function(){
    return{async connect(){const index=++acquired;return{query:async sql=>{queries.push(sql);if(index===1)throw failure;return{rows:[{ready:true}]}},release:error=>released.push(error)}}};
  });
  const db=createSchoolDb(config);await assert.rejects(db.query('SELECT * FROM school_profiles'),failure);
  assert.equal(released[0],failure);assert.equal(queries.filter(sql=>sql.startsWith('SELECT')).length,0);
  assert.deepEqual((await db.query('SELECT * FROM school_profiles')).rows,[{ready:true}]);assert.equal(released[1],undefined);
});
