import vm from 'node:vm';
import {it,expect} from 'vitest';
import {commercialControlFrontend} from './commercial-control2-ui.js';

const schools=[{id:'alpha-id',name:'Alpha School',slug:'alpha',access_status:'active'},{id:'beta-id',name:'Beta School',slug:'beta',access_status:'disabled'}];
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function browser(respond?:(url:string,body:any)=>any){
  const elements=new Map<string,any>(),calls:{url:string;body:any}[]=[],copies:string[]=[],downloads:string[]=[];
  function make(id:string){const e:any={id,value:'',textContent:'',disabled:false,style:{},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],focus(){},checkValidity:()=>true,click(){downloads.push(this.download)}};let html='';Object.defineProperty(e,'innerHTML',{get:()=>html,set:(value:string)=>{html=value;parse(value)}});elements.set(id,e);return e}
  function parse(html:string){for(const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){const e=make(match[1]!);e.value=match[0].match(/\bvalue="([^"]*)"/)?.[1]||'';e.disabled=/\sdisabled(?:\s|>)/.test(match[0])}
    for(const match of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){elements.get(match[1]!)!.value=match[2]!.match(/<option value="([^"]*)"/)?.[1]||''}}
  parse(commercialControlFrontend.split('<script>')[0]!);make('nav');
  const context:any={document:{getElementById:(id:string)=>elements.get(id)||null,querySelector:()=>elements.get('nav'),querySelectorAll:()=>[],createElement:()=>make('download')},
    sessionStorage:{getItem:(key:string)=>key==='rx_access'?'test-token':'',setItem(){},removeItem(){}},location:{origin:'https://os.example.test',href:'https://os.example.test/commercial-control',replace(){}},
    navigator:{clipboard:{writeText:(s:string)=>copies.push(s)}},URL,URLSearchParams,Request,Headers,Blob,crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},clearTimeout(){},setTimeout:()=>0,window:{print(){}},
    fetch:async(url:string,options:any)=>{const body=options?.body?JSON.parse(options.body):undefined;calls.push({url,body});let data:any;
      if(url==='/v1/auth/context')data={permissions:['commercial.read']};else if(url==='/v1/commercial-control/catalog')data={plans:[],modules:[]};else if(url==='/v1/commercial-control/schools'&&!options?.method)data=schools;else if(url==='/v1/commercial-control/overview')data={};else data=respond?.(url,body)??{};
      return{ok:true,status:200,headers:new Headers(),text:async()=>typeof data==='string'?data:JSON.stringify(data)}}};
  context.print=context.window.print;context.window=context;
  vm.runInNewContext(commercialControlFrontend.match(/<script>([\s\S]*?)<\/script>/i)![1]!,context);await flush();
  const E=(id:string)=>elements.get(id);
  async function navigate(page:string){E('nav').onclick({target:{closest:()=>({dataset:{page}})}});await flush()}
  return{E,calls,copies,downloads,navigate};
}
const order=(canCreate=true)=>({invoice:{invoice_no:'RX-PAID',status:canCreate?'paid':'part_paid',total:100,amount_paid:canCreate?100:25,currency:'GHS',school_details:{name:'Alpha School',adminFirstName:'Alpha',adminLastName:'Admin',adminEmail:'alpha@example.test',billingFrequency:'monthly'}},canCreate});

it('blocks school creation until the invoice is verified and fully paid',async()=>{
  const b=await browser(()=>order(false));b.E('newSchool').onclick();expect(b.E('mSave').disabled).toBe(true);await b.E('mSave').onclick();expect(b.calls.some(x=>x.body?.invoiceNumber)).toBe(false);
  b.E('paidInvoiceNumber').value='RX-PARTIAL';await b.E('validateInvoice').onclick();expect(b.E('mSave').disabled).toBe(true);await b.E('mSave').onclick();expect(b.calls.some(x=>x.body?.invoiceNumber)).toBe(false);
});
it('creates from the validated invoice only and displays and copies the temporary administrator credentials',async()=>{
  const b=await browser((url)=>url==='/v1/commercial-control/schools'?{organisation:{id:'alpha-id',name:'Alpha School'},invoiceNumber:'RX-PAID',administrator:{email:'alpha@example.test',temporaryPassword:'TestTemporary123'},provisioning:{status:'completed'},adminLoginUrl:'https://school.example.test/s/alpha/admin-login'}:order());
  b.E('newSchool').onclick();b.E('paidInvoiceNumber').value='rx-paid';await b.E('validateInvoice').onclick();expect(b.E('mSave').disabled).toBe(false);
  await b.E('mSave').onclick();const creation=b.calls.find(x=>x.url==='/v1/commercial-control/schools'&&x.body);expect(creation?.body).toEqual({invoiceNumber:'RX-PAID'});
  expect(b.E('createdTemporaryPassword').value).toBe('TestTemporary123');b.E('copyCreated').onclick();expect(b.copies[0]).toContain('Temporary password: TestTemporary123');expect(b.copies[0]).toContain('/s/alpha/admin-login');
});
it('requires revalidation after an invoice number is edited',async()=>{
  const b=await browser(()=>order());b.E('newSchool').onclick();b.E('paidInvoiceNumber').value='RX-PAID';await b.E('validateInvoice').onclick();b.E('paidInvoiceNumber').value='RX-OTHER';b.E('paidInvoiceNumber').oninput();await b.E('mSave').onclick();expect(b.calls.some(x=>x.body?.invoiceNumber)).toBe(false);
});
it('loads no administrator logs until a school is selected and spools the chosen period',async()=>{
  const b=await browser(url=>url.includes('format=csv')?'School,Action\r\nAlpha School,staff.created':[{school_name:'Alpha School',actor_name:'Admin',action:'staff.created'}]);await b.navigate('activity');
  expect(b.calls.some(x=>x.url.includes('admin-activity'))).toBe(false);await b.E('loadActivity').onclick();expect(b.calls.some(x=>x.url.includes('admin-activity'))).toBe(false);
  b.E('activitySchool').value='alpha-id';b.E('activityFrom').value='2026-10-01';b.E('activityTo').value='2026-10-11';await b.E('loadActivity').onclick();expect(b.E('activityRows').innerHTML).toContain('Alpha School');await b.E('exportActivity').onclick();
  expect(b.calls.at(-1)?.url).toContain('schoolId=alpha-id&from=2026-10-01&to=2026-10-11&format=csv');expect(b.downloads[0]).toContain('2026-10-01-2026-10-11.csv');
});
it('selects a school to display all payments and filters active and disabled school records',async()=>{
  const b=await browser(()=>({school:schools[0],invoices:[],payments:[{invoice_no:'RX-PAID',amount:100,payment_method:'bank_transfer',provider_reference:'BANK-001'}]}));await b.navigate('billing');expect(b.calls.some(x=>x.url.includes('school-billing'))).toBe(false);
  b.E('billingSchool').value='alpha-id';b.E('billingSchool').onchange();await flush();expect(b.E('billingRows').innerHTML).toContain('BANK-001');expect(b.E('billingRows').innerHTML).toContain('All Payments (1)');
  await b.navigate('schools');b.E('schoolState').value='disabled';b.E('schoolState').onchange();expect(b.E('schoolRows').innerHTML).toContain('Beta School');expect(b.E('schoolRows').innerHTML).not.toContain('Alpha School');
});

