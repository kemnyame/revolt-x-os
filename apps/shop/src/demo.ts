import type { Db } from './db.js';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { tx } from './db.js';
import type { DemoPersona } from './auth.js';

const demoRole=(persona:DemoPersona)=>persona;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const randomPasswordHash=()=>{const salt=randomBytes(16).toString('hex');return 'scrypt

export async function ensureDemoWorkspace(
  db:Db,
  input:{organisationId:string;userId:string;persona:DemoPersona}
){
  return tx(db,async client=>{
    await client.query(
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,$3,'active')
       ON CONFLICT(organisation_id,os_user_id)
       DO UPDATE SET role=EXCLUDED.role,status='active'`,
      [input.organisationId,input.userId,demoRole(input.persona)]
    );

    let shop=(await client.query(
      `SELECT * FROM shops
       WHERE organisation_id=$1 AND slug='demo-barbering-studio'
       LIMIT 1`,
      [input.organisationId]
    )).rows[0];

    if(!shop){
      shop=(await client.query(
        `INSERT INTO shops(
          organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,status,created_by
        )
        VALUES(
          $1,'Revolt Demo Barbering Studio','demo-barbering-studio',
          'revolt-x-shop-demo-barbering-studio','barbering_salon','GHS',
          '0550000000','demo@revolt-x.local','Accra, Ghana','active',$2
        )
        RETURNING *`,
        [input.organisationId,input.userId]
      )).rows[0];
    }

    let branch=(await client.query(
      `SELECT * FROM shop_branches WHERE shop_id=$1 AND name='Main Salon' LIMIT 1`,
      [shop.id]
    )).rows[0];
    if(!branch){
      branch=(await client.query(
        `INSERT INTO shop_branches(
          organisation_id,shop_id,name,code,phone,email,address,status
        )
        VALUES($1,$2,'Main Salon','MAIN','0550000000','demo@revolt-x.local','Accra, Ghana','active')
        RETURNING *`,
        [input.organisationId,shop.id]
      )).rows[0];
    }

    await client.query(
      `INSERT INTO salon_settings(
        shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer
      )
      VALUES($1,$2,'Africa/Accra',15,true,true,0,'Thank you for visiting Revolt Demo Barbering Studio.')
      ON CONFLICT(shop_id) DO UPDATE SET updated_at=now()`,
      [shop.id,input.organisationId]
    );

    for(let day=0;day<=6;day++){
      await client.query(
        `INSERT INTO salon_business_hours(
          organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed
        )
        VALUES($1,$2,$3,$4,'08:00','20:00',$5)
        ON CONFLICT(branch_id,day_of_week) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,day,day===0]
      );
    }

    const staff=[
      ['BAR-001','Kwame Asare','Senior Barber','40'],
      ['BAR-002','Daniel Mensah','Fade & Styling Specialist','35'],
      ['BAR-003','Kojo Boateng','Barber & Beard Specialist','35']
    ];
    for(const [no,name,specialty,commission] of staff){
      await client.query(
        `INSERT INTO salon_staff(
          organisation_id,shop_id,branch_id,staff_no,full_name,role,specialty,commission_percent,status
        )
        VALUES($1,$2,$3,$4,$5,'barber',$6,$7,'active')
        ON CONFLICT(shop_id,staff_no) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,no,name,specialty,commission]
      );
    }

    for(let i=1;i<=4;i++){
      await client.query(
        `INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,status)
         VALUES($1,$2,$3,$4,$5,'available')
         ON CONFLICT(shop_id,name) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,'Chair '+i,'CH-'+String(i).padStart(2,'0')]
      );
    }

    const services=[
      ['Classic Haircut','Barbering','Professional classic haircut',70,35],
      ['Skin Fade','Barbering','Precision skin fade',100,50],
      ['Beard Trim & Line-up','Beard Care','Beard trim and sharp line-up',50,25],
      ['Haircut + Beard Combo','Grooming','Complete haircut and beard grooming',130,60],
      ['VIP Grooming Experience','Premium','Premium haircut, beard care and finishing',180,75]
    ] as const;
    for(const [name,category,description,price,duration] of services){
      await client.query(
        `INSERT INTO shop_services(
          organisation_id,shop_id,name,category,description,price,duration_minutes,deposit_percent,active
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,0,true
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_services WHERE shop_id=$2 AND lower(name)=lower($3)
        )`,
        [input.organisationId,shop.id,name,category,description,price,duration]
      );
    }

    const products=[
      ['DEMO-POMADE','Premium Pomade','Hair Care',25,45,20,5],
      ['DEMO-BEARD-OIL','Beard Oil','Beard Care',30,55,15,4],
      ['DEMO-AFTERSHAVE','Cooling Aftershave','Grooming',22,40,18,5]
    ] as const;
    for(const [sku,name,category,cost,sell,qty,reorder] of products){
      await client.query(
        `INSERT INTO shop_products(
          organisation_id,shop_id,sku,name,category,cost_price,selling_price,stock_quantity,reorder_level,active
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
        ON CONFLICT(shop_id,sku) DO NOTHING`,
        [input.organisationId,shop.id,sku,name,category,cost,sell,qty,reorder]
      );
    }

    const customers=[
      ['DEMO-CUS-001','Michael Addo','0240000001','michael.demo@revolt-x.local','active',null],
      ['DEMO-CUS-002','Samuel Ofori','0240000002','samuel.demo@revolt-x.local','active',null],
      ['DEMO-CUS-003','Prince Arthur','0240000003','prince.demo@revolt-x.local','active',null],
      ['DEMO-CUS-004','Adwoa Mensah','0240000004','adwoa.demo@revolt-x.local','active',null],
      ['DEMO-CUS-005','Joseph Nartey','0240000005','joseph.demo@revolt-x.local','inactive','2026-04-10T10:00:00Z']
    ] as const;
    for(const [no,name,phone,email,status,lastVisit] of customers){
      await client.query(
        `INSERT INTO shop_customers(
          organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status,last_visit_at,inactive_at
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,'retail',$8,$9::timestamptz,CASE WHEN $8='inactive' THEN now() ELSE NULL END
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_customers WHERE shop_id=$2 AND customer_no=$4
        )`,
        [input.organisationId,shop.id,branch.id,no,name,phone,email,status,lastVisit]
      );
    }

    return{shopId:shop.id,branchId:branch.id};
  });
}
+salt+'

export async function ensureDemoWorkspace(
  db:Db,
  input:{organisationId:string;userId:string;persona:DemoPersona}
){
  return tx(db,async client=>{
    await client.query(
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,$3,'active')
       ON CONFLICT(organisation_id,os_user_id)
       DO UPDATE SET role=EXCLUDED.role,status='active'`,
      [input.organisationId,input.userId,demoRole(input.persona)]
    );

    let shop=(await client.query(
      `SELECT * FROM shops
       WHERE organisation_id=$1 AND slug='demo-barbering-studio'
       LIMIT 1`,
      [input.organisationId]
    )).rows[0];

    if(!shop){
      shop=(await client.query(
        `INSERT INTO shops(
          organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,status,created_by
        )
        VALUES(
          $1,'Revolt Demo Barbering Studio','demo-barbering-studio',
          'revolt-x-shop-demo-barbering-studio','barbering_salon','GHS',
          '0550000000','demo@revolt-x.local','Accra, Ghana','active',$2
        )
        RETURNING *`,
        [input.organisationId,input.userId]
      )).rows[0];
    }

    let branch=(await client.query(
      `SELECT * FROM shop_branches WHERE shop_id=$1 AND name='Main Salon' LIMIT 1`,
      [shop.id]
    )).rows[0];
    if(!branch){
      branch=(await client.query(
        `INSERT INTO shop_branches(
          organisation_id,shop_id,name,code,phone,email,address,status
        )
        VALUES($1,$2,'Main Salon','MAIN','0550000000','demo@revolt-x.local','Accra, Ghana','active')
        RETURNING *`,
        [input.organisationId,shop.id]
      )).rows[0];
    }

    await client.query(
      `INSERT INTO salon_settings(
        shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer
      )
      VALUES($1,$2,'Africa/Accra',15,true,true,0,'Thank you for visiting Revolt Demo Barbering Studio.')
      ON CONFLICT(shop_id) DO UPDATE SET updated_at=now()`,
      [shop.id,input.organisationId]
    );

    for(let day=0;day<=6;day++){
      await client.query(
        `INSERT INTO salon_business_hours(
          organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed
        )
        VALUES($1,$2,$3,$4,'08:00','20:00',$5)
        ON CONFLICT(branch_id,day_of_week) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,day,day===0]
      );
    }

    const staff=[
      ['BAR-001','Kwame Asare','Senior Barber','40'],
      ['BAR-002','Daniel Mensah','Fade & Styling Specialist','35'],
      ['BAR-003','Kojo Boateng','Barber & Beard Specialist','35']
    ];
    for(const [no,name,specialty,commission] of staff){
      await client.query(
        `INSERT INTO salon_staff(
          organisation_id,shop_id,branch_id,staff_no,full_name,role,specialty,commission_percent,status
        )
        VALUES($1,$2,$3,$4,$5,'barber',$6,$7,'active')
        ON CONFLICT(shop_id,staff_no) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,no,name,specialty,commission]
      );
    }

    for(let i=1;i<=4;i++){
      await client.query(
        `INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,status)
         VALUES($1,$2,$3,$4,$5,'available')
         ON CONFLICT(shop_id,name) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,'Chair '+i,'CH-'+String(i).padStart(2,'0')]
      );
    }

    const services=[
      ['Classic Haircut','Barbering','Professional classic haircut',70,35],
      ['Skin Fade','Barbering','Precision skin fade',100,50],
      ['Beard Trim & Line-up','Beard Care','Beard trim and sharp line-up',50,25],
      ['Haircut + Beard Combo','Grooming','Complete haircut and beard grooming',130,60],
      ['VIP Grooming Experience','Premium','Premium haircut, beard care and finishing',180,75]
    ] as const;
    for(const [name,category,description,price,duration] of services){
      await client.query(
        `INSERT INTO shop_services(
          organisation_id,shop_id,name,category,description,price,duration_minutes,deposit_percent,active
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,0,true
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_services WHERE shop_id=$2 AND lower(name)=lower($3)
        )`,
        [input.organisationId,shop.id,name,category,description,price,duration]
      );
    }

    const products=[
      ['DEMO-POMADE','Premium Pomade','Hair Care',25,45,20,5],
      ['DEMO-BEARD-OIL','Beard Oil','Beard Care',30,55,15,4],
      ['DEMO-AFTERSHAVE','Cooling Aftershave','Grooming',22,40,18,5]
    ] as const;
    for(const [sku,name,category,cost,sell,qty,reorder] of products){
      await client.query(
        `INSERT INTO shop_products(
          organisation_id,shop_id,sku,name,category,cost_price,selling_price,stock_quantity,reorder_level,active
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
        ON CONFLICT(shop_id,sku) DO NOTHING`,
        [input.organisationId,shop.id,sku,name,category,cost,sell,qty,reorder]
      );
    }

    const customers=[
      ['DEMO-CUS-001','Michael Addo','0240000001'],
      ['DEMO-CUS-002','Samuel Ofori','0240000002'],
      ['DEMO-CUS-003','Prince Arthur','0240000003']
    ] as const;
    for(const [no,name,phone] of customers){
      await client.query(
        `INSERT INTO shop_customers(
          organisation_id,shop_id,branch_id,customer_no,name,phone,customer_type,status
        )
        SELECT $1,$2,$3,$4,$5,$6,'retail','active'
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_customers WHERE shop_id=$2 AND customer_no=$4
        )`,
        [input.organisationId,shop.id,branch.id,no,name,phone]
      );
    }

    return{shopId:shop.id,branchId:branch.id};
  });
}
+scryptSync(randomBytes(24).toString('hex'),salt,64).toString('hex')};

export async function ensureDemoWorkspace(
  db:Db,
  input:{organisationId:string;userId:string;persona:DemoPersona}
){
  return tx(db,async client=>{
    await client.query(
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,$3,'active')
       ON CONFLICT(organisation_id,os_user_id)
       DO UPDATE SET role=EXCLUDED.role,status='active'`,
      [input.organisationId,input.userId,demoRole(input.persona)]
    );

    let shop=(await client.query(
      `SELECT * FROM shops
       WHERE organisation_id=$1 AND slug='demo-barbering-studio'
       LIMIT 1`,
      [input.organisationId]
    )).rows[0];

    if(!shop){
      shop=(await client.query(
        `INSERT INTO shops(
          organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,status,created_by
        )
        VALUES(
          $1,'Revolt Demo Barbering Studio','demo-barbering-studio',
          'revolt-x-shop-demo-barbering-studio','barbering_salon','GHS',
          '0550000000','demo@revolt-x.local','Accra, Ghana','active',$2
        )
        RETURNING *`,
        [input.organisationId,input.userId]
      )).rows[0];
    }

    let branch=(await client.query(
      `SELECT * FROM shop_branches WHERE shop_id=$1 AND name='Main Salon' LIMIT 1`,
      [shop.id]
    )).rows[0];
    if(!branch){
      branch=(await client.query(
        `INSERT INTO shop_branches(
          organisation_id,shop_id,name,code,phone,email,address,status
        )
        VALUES($1,$2,'Main Salon','MAIN','0550000000','demo@revolt-x.local','Accra, Ghana','active')
        RETURNING *`,
        [input.organisationId,shop.id]
      )).rows[0];
    }

    await client.query(
      `INSERT INTO salon_settings(
        shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer
      )
      VALUES($1,$2,'Africa/Accra',15,true,true,0,'Thank you for visiting Revolt Demo Barbering Studio.')
      ON CONFLICT(shop_id) DO UPDATE SET updated_at=now()`,
      [shop.id,input.organisationId]
    );

    for(let day=0;day<=6;day++){
      await client.query(
        `INSERT INTO salon_business_hours(
          organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed
        )
        VALUES($1,$2,$3,$4,'08:00','20:00',$5)
        ON CONFLICT(branch_id,day_of_week) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,day,day===0]
      );
    }

    const staff=[
      ['BAR-001','Kwame Asare','Senior Barber','40'],
      ['BAR-002','Daniel Mensah','Fade & Styling Specialist','35'],
      ['BAR-003','Kojo Boateng','Barber & Beard Specialist','35']
    ];
    for(const [no,name,specialty,commission] of staff){
      await client.query(
        `INSERT INTO salon_staff(
          organisation_id,shop_id,branch_id,staff_no,full_name,role,specialty,commission_percent,status
        )
        VALUES($1,$2,$3,$4,$5,'barber',$6,$7,'active')
        ON CONFLICT(shop_id,staff_no) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,no,name,specialty,commission]
      );
    }

    for(let i=1;i<=4;i++){
      await client.query(
        `INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,status)
         VALUES($1,$2,$3,$4,$5,'available')
         ON CONFLICT(shop_id,name) DO NOTHING`,
        [input.organisationId,shop.id,branch.id,'Chair '+i,'CH-'+String(i).padStart(2,'0')]
      );
    }

    const services=[
      ['Classic Haircut','Barbering','Professional classic haircut',70,35],
      ['Skin Fade','Barbering','Precision skin fade',100,50],
      ['Beard Trim & Line-up','Beard Care','Beard trim and sharp line-up',50,25],
      ['Haircut + Beard Combo','Grooming','Complete haircut and beard grooming',130,60],
      ['VIP Grooming Experience','Premium','Premium haircut, beard care and finishing',180,75]
    ] as const;
    for(const [name,category,description,price,duration] of services){
      await client.query(
        `INSERT INTO shop_services(
          organisation_id,shop_id,name,category,description,price,duration_minutes,deposit_percent,active
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,0,true
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_services WHERE shop_id=$2 AND lower(name)=lower($3)
        )`,
        [input.organisationId,shop.id,name,category,description,price,duration]
      );
    }

    const products=[
      ['DEMO-POMADE','Premium Pomade','Hair Care',25,45,20,5],
      ['DEMO-BEARD-OIL','Beard Oil','Beard Care',30,55,15,4],
      ['DEMO-AFTERSHAVE','Cooling Aftershave','Grooming',22,40,18,5]
    ] as const;
    for(const [sku,name,category,cost,sell,qty,reorder] of products){
      await client.query(
        `INSERT INTO shop_products(
          organisation_id,shop_id,sku,name,category,cost_price,selling_price,stock_quantity,reorder_level,active
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
        ON CONFLICT(shop_id,sku) DO NOTHING`,
        [input.organisationId,shop.id,sku,name,category,cost,sell,qty,reorder]
      );
    }

    const customers=[
      ['DEMO-CUS-001','Michael Addo','0240000001'],
      ['DEMO-CUS-002','Samuel Ofori','0240000002'],
      ['DEMO-CUS-003','Prince Arthur','0240000003']
    ] as const;
    for(const [no,name,phone] of customers){
      await client.query(
        `INSERT INTO shop_customers(
          organisation_id,shop_id,branch_id,customer_no,name,phone,customer_type,status
        )
        SELECT $1,$2,$3,$4,$5,$6,'retail','active'
        WHERE NOT EXISTS(
          SELECT 1 FROM shop_customers WHERE shop_id=$2 AND customer_no=$4
        )`,
        [input.organisationId,shop.id,branch.id,no,name,phone]
      );
    }

    return{shopId:shop.id,branchId:branch.id};
  });
}


export async function createDemoCustomerSession(db:Db){
  return tx(db,async client=>{
    const shop=(await client.query(
      `SELECT s.*,o.id organisation_id
       FROM shops s JOIN revolt_x_os.organisations o ON o.id=s.organisation_id
       WHERE o.slug='revolt-x-shop-demo' AND s.slug='demo-barbering-studio'
       LIMIT 1`
    )).rows[0];
    if(!shop)throw new Error('Open a Shop demo staff user once before opening the customer demo');

    let customer=(await client.query(
      `SELECT * FROM shop_customers WHERE shop_id=$1 AND customer_no='DEMO-CUS-004' LIMIT 1`,
      [shop.id]
    )).rows[0];
    if(!customer){
      const branch=(await client.query("SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[shop.id])).rows[0];
      customer=(await client.query(
        `INSERT INTO shop_customers(
          organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status,portal_registered_at
        )
        VALUES($1,$2,$3,'DEMO-CUS-004','Adwoa Mensah','0240000004','adwoa.demo@revolt-x.local','retail','active',now())
        RETURNING *`,
        [shop.organisation_id,shop.id,branch?.id||null]
      )).rows[0];
    }

    let account=(await client.query(
      'SELECT * FROM shop_customer_portal_accounts WHERE shop_id=$1 AND customer_id=$2 LIMIT 1',
      [shop.id,customer.id]
    )).rows[0];
    if(!account){
      account=(await client.query(
        `INSERT INTO shop_customer_portal_accounts(
          organisation_id,shop_id,customer_id,email,phone,password_hash,status
        ) VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
        [shop.organisation_id,shop.id,customer.id,customer.email,customer.phone,randomPasswordHash()]
      )).rows[0];
    }

    const discount=await client.query(
      `SELECT 1 FROM shop_customer_discounts
       WHERE shop_id=$1 AND customer_id=$2 AND status='active'
         AND reason='Customer portal registration' LIMIT 1`,
      [shop.id,customer.id]
    );
    if(!discount.rowCount){
      await client.query(
        `INSERT INTO shop_customer_discounts(
          organisation_id,shop_id,customer_id,code,discount_type,discount_value,reason,expires_at
        ) VALUES($1,$2,$3,'DEMO-WELCOME','percent',10,'Customer portal registration',now()+interval '90 days')`,
        [shop.organisation_id,shop.id,customer.id]
      );
    }

    const token=randomBytes(36).toString('base64url');
    await client.query(
      `INSERT INTO shop_customer_sessions(account_id,token_hash,expires_at)
       VALUES($1,$2,now()+interval '30 days')`,
      [account.id,sha(token)]
    );
    return{token,path:'/customer/'+(shop.public_slug||shop.slug),customer:{id:customer.id,name:customer.name}};
  });
}
