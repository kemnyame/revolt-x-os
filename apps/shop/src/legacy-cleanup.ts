import type { Db } from './db.js';

export async function purgeLegacyShopDemoData(db:Db){
  const result=await db.query(
    `DELETE FROM shops
     WHERE slug='revolt-cuts'
       AND name='Revolt Cuts Barbering Salon'
       AND coalesce(email,'')='hello@revoltcuts.com'
     RETURNING id`
  );

  await db.query(
    `DELETE FROM shop_bootstrap_state
     WHERE key LIKE 'salon-demo:%'
        OR key LIKE 'credentials:%'`
  );

  return{removedShops:result.rowCount??0};
}
