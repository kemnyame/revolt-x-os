import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';

const pg=new PGlite();
beforeAll(async()=>{
 const dir=new URL('../../migrations/',import.meta.url);
 for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())await pg.exec(readFileSync(new URL(file,dir),'utf8'));
});
afterAll(()=>pg.close());
it('includes the School mobile app from Growth upward without changing plan prices',async()=>{
 const rows=(await pg.query(`SELECT p.plan_key,p.monthly_price,x.included,m.base_monthly_price,m.dependency_keys
   FROM saas_pricing_plans p JOIN saas_plan_modules x ON x.plan_id=p.id JOIN saas_product_modules m ON m.id=x.module_id
   WHERE m.module_key='school.mobile' ORDER BY p.sort_order`)).rows as {plan_key:string;included:boolean;base_monthly_price:string;dependency_keys:string[]}[];
 expect(Object.fromEntries(rows.map(r=>[r.plan_key,r.included]))).toEqual({basic:false,starter:false,growth:true,professional:true,enterprise:true});
 expect(rows.every(r=>Number(r.base_monthly_price)===0&&r.dependency_keys.includes('school.core'))).toBe(true);
 const before=(await pg.query('SELECT id,monthly_price,termly_price,annual_price FROM saas_pricing_plans ORDER BY id')).rows;
 await pg.exec(readFileSync(new URL('../../migrations/017_school_mobile_growth.sql',import.meta.url),'utf8'));
 expect((await pg.query('SELECT id,monthly_price,termly_price,annual_price FROM saas_pricing_plans ORDER BY id')).rows).toEqual(before);
 expect((await pg.query("SELECT count(*) n FROM saas_product_modules WHERE module_key='school.mobile'")).rows[0]).toEqual({n:1});
});
