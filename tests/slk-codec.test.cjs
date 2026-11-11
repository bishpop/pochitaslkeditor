const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path');
const root=path.join(__dirname,'..','public')+path.sep;
const ctx={console,atob,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,DataView,Map,window:null,makeId:(()=>{let n=0;return()=>`doc${++n}`})(),basename:s=>String(s).split(/[\\/]/).pop(),syncMetaFromRecords(d){const width=Math.max(1,d.headers?.length||0,...d.records.slice(0,5).map(r=>r.length));d.headers=Array.from({length:width},(_,i)=>String(d.records[0]?.[i]??`Column ${i+1}`));d.types=Array.from({length:width},(_,i)=>String(d.records[1]?.[i]??'string'));d.columnCount=d.headers.length;d.rowCount=d.records.length;}};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root+'vendor/cp949.js','utf8'),ctx);
const app=fs.readFileSync(root+'app.js','utf8');
const a=app.indexOf('function detectLegacySlkEncoding');const b=app.indexOf('function quoteSlk(value)');
assert(a>=0&&b>a);
vm.runInContext(app.slice(a,b),ctx);
const quoteStart=app.indexOf('function quoteSlk');const encStart=app.indexOf('function encodeWindows1252');
vm.runInContext(app.slice(quoteStart,encStart),ctx);const encEnd=app.indexOf('function serializeDoc',encStart);
vm.runInContext(app.slice(encStart,encEnd),ctx);
const serialStart=app.indexOf('function serializeDoc');const serialEnd=app.indexOf('function downloadBytes',serialStart);
vm.runInContext(app.slice(serialStart,serialEnd),ctx);
const bytes=s=>new TextEncoder().encode(s);
const sylk='ID;P\r\nB;Y3;X2\r\nC;Y1;X1;K"Artist"\r\nC;X2;K"Song;;Title"\r\nC;Y2;X1;Kstring\r\nC;X2;Kstring\r\nC;Y3;X1;K"Müller"\r\nC;X2;K"She said ""Hi"""\r\nE\r\n';
function utf16(text,littleEndian=true,bom=true){
 const out=new Uint8Array((bom?2:0)+text.length*2),offset=bom?2:0;
 if(bom){out[0]=littleEndian?0xFF:0xFE;out[1]=littleEndian?0xFE:0xFF;}
 const view=new DataView(out.buffer);for(let i=0;i<text.length;i++)view.setUint16(offset+i*2,text.charCodeAt(i),littleEndian);
 return out;
}

test('SYLK parser accepts either coordinate order, sticky coordinates and escaped values',()=>{
 const doc=ctx.parseSlk('sticky.slk',bytes(sylk));
 assert.deepEqual(Array.from(doc.records,row=>Array.from(row)),[
  ['Artist','Song;Title'],['string','string'],['Müller','She said "Hi"']
 ]);
 assert.equal(doc.encoding,'utf-8');
});

test('UTF-8 BOM and UTF-16 LE/BE with and without BOM are detected',()=>{
 const fixtures=[
  ['utf8bom.slk',Uint8Array.from([0xEF,0xBB,0xBF,...bytes(sylk)]),'utf-8-sig'],
  ['utf16le.slk',utf16(sylk,true,true),'utf-16le'],
  ['utf16be.slk',utf16(sylk,false,true),'utf-16be'],
  ['utf16nobom.slk',utf16(sylk,true,false),'utf-16le'],
  ['utf16benobom.slk',utf16(sylk,false,false),'utf-16be']
 ];
 for(const [name,raw,expected] of fixtures){
  const doc=ctx.parseSlk(name,raw);assert.equal(doc.encoding,expected,name);
  assert.equal(doc.records[2][0],'Müller',name);
 }
});

test('Windows-1252 and CP949 are detected and can be exported again',()=>{
 const western=sylk.replace('Müller','Müller').replace('She said ""Hi""','Björk');
 const westernBytes=ctx.encodeWindows1252(western),westernDoc=ctx.parseSlk('western.slk',westernBytes);
 assert.equal(westernDoc.encoding,'windows-1252');assert.equal(westernDoc.records[2][1],'Björk');
 assert.deepEqual(Array.from(ctx.encodeSlkText(western,'windows-1252')),Array.from(westernBytes));
 const loneUmlaut='ID;P\r\nC;Y1;X1;K\"Title\"\r\nC;Y2;X1;Kstring\r\nC;Y3;X1;K\"Größe\"\r\nE\r\n';
 const loneDoc=ctx.parseSlk('groesse.slk',ctx.encodeWindows1252(loneUmlaut));
 assert.equal(loneDoc.encoding,'windows-1252');assert.equal(loneDoc.records[2][0],'Größe');
 const korean='ID;P\r\nC;Y1;X1;K"가수"\r\nC;Y2;X1;Kstring\r\nC;Y3;X1;K"한국어"\r\nE\r\n';
 const koreanDoc=ctx.parseSlk('korean.slk',ctx.PochitaCP949.encode(korean));
 assert.equal(koreanDoc.encoding,'cp949');assert.equal(koreanDoc.records[2][0],'한국어');
});

test('serialize/parse round-trip preserves supported encodings',()=>{
 for(const encoding of ['utf-8','utf-8-sig','utf-16le','utf-16be','cp949','windows-1252']){
  const headers=encoding==='cp949'?['가수','노래']:['Artist','Title'];
  const song=encoding==='cp949'?['가수','한국어']:['Müller','Björk'];
  const records=[headers,['string','string'],song];
  const doc={id:'test',filename:'roundtrip.slk',exportName:'roundtrip.slk',encoding,newline:'\r\n',idLine:'ID;P',endLine:'E',headers,types:records[1],records,rowCount:3,columnCount:2};
  const reread=ctx.parseSlk('roundtrip.slk',ctx.serializeDoc(doc));
  assert.equal(reread.encoding,encoding);
  assert.deepEqual(Array.from(reread.records,row=>Array.from(row)),records);
 }
});

test('tab-separated input is accepted as a fallback',()=>{
 const doc=ctx.parseSlk('fallback.slk',bytes('Artist\tTitle\nstring\tstring\nABBA\tWaterloo\n'));
 assert.equal(doc.records[2][1],'Waterloo');
});
