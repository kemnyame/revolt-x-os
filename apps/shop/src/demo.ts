import type { Db } from './db.js';
import { tx } from './db.js';
import type { DemoPersona } from './auth.js';

const demoRole=(persona:DemoPersona)=>persona;

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
