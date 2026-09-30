import type { Db } from './db.js';
import { tx } from './db.js';

export async function purgeLegacyShopDemoData(db:Db){
  const key='legacy-cleanup:commercial-v1';
  const done=await db.query('SELECT 1 FROM shop_bootstrap_state WHERE key=$1',[key]);
  if(done.rowCount)return{removedShops:0,alreadyApplied:true};

  return tx(db,async client=>{
    const result=await client.query(
      `DELETE FROM shops
       WHERE slug='revolt-cuts'
         AND name='Revolt Cuts Barbering Salon'
         AND coalesce(email,'')='hello@revoltcuts.com'
       RETURNING id`
    );

    await client.query(
      `DELETE FROM shop_bootstrap_state
       WHERE key LIKE 'salon-demo:%'
          OR key LIKE 'credentials:%'`
    );
    await client.query('INSERT INTO shop_bootstrap_state(key) VALUES($1) ON CONFLICT DO NOTHING',[key]);

    return{removedShops:result.rowCount??0,alreadyApplied:false};
  });
}
