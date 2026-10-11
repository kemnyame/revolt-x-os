import {z} from 'zod';

export const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/,'Use a date in YYYY-MM-DD format.')
  .refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Select a valid calendar date.');
export const schoolReportQuery=z.object({
  schoolId:z.string().uuid('Select a school before loading administrator logs.'),
  from:calendarDate.optional(),to:calendarDate.optional(),format:z.enum(['json','csv']).default('json'),
  limit:z.coerce.number().int().min(1).max(1000).default(200)
}).refine(value=>!value.from||!value.to||value.from<=value.to,{message:'The end date must be on or after the start date.',path:['to']})
  .refine(value=>value.format!=='csv'||Boolean(value.from&&value.to),{message:'Select the start and end dates before exporting administrator logs.',path:['from']});

export function csvReport(rows:Record<string,unknown>[],columns:{key:string;label:string}[]){
  const cell=(value:unknown)=>{
    let text=String(value??'');
    // Export text as text even when a school name or reference begins like an Excel formula.
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  };
  return '\ufeff'+[columns.map(x=>cell(x.label)).join(','),...rows.map(row=>columns.map(x=>cell(row[x.key])).join(','))].join('\r\n');
}

export function schoolAccessStatus(row:any,now=Date.now()){
  if(row.organisation_status!=='active'||row.customer_status==='archived')return'disabled';
  const status=row.licence_status,date=status==='trial'?row.trial_ends_at:status==='grace'?row.grace_ends_at:row.current_period_end;
  return ['active','trial','grace'].includes(status)&&(!date||new Date(date).getTime()>now)?'active':'disabled';
}
