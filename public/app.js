const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let docs = [], activeId = null, rootId = null, splitMode = false, viewIds = [], query = '', dirty = new Set();
let coverageDismissed = false;
let undoStack = [], redoStack = [];
let compactMode = document.documentElement.dataset.density === 'compact';
let syncFieldKeys = new Set();
let entryDrafts = [], entryTargetLevels = [], selectedTbmPrefix = 'g';
let viewStamp = 0;                                   // bumped whenever the row filter must be recomputed
let freezeCols = false, crosshair = true, enterEdits = false;
const selById = {};                                  // docId -> {a:{p,c}, f:{p,c}, extra:[range]} (p = visible row position)
const gridById = {};                                 // docId -> grid instance (DOM + virtual scroll state)
let edit = null;                                     // active cell edit: {g,id,p,r,c,orig,mode:'enter'|'edit',source:'cell'|'bar'}
let appReady = false;

const SYNC_FIELD_CANDIDATES = [
 {key:'singer', label:'Singer / Artist'}, {key:'title', label:'Title'}, {key:'filename', label:'File name'},
 {key:'bpm', label:'BPM'}, {key:'offset', label:'Offset'}, {key:'new', label:'New'}, {key:'use', label:'Use'}
];
const DEFAULT_SYNC_FIELD_KEYS = new Set(['singer','title','filename','bpm','offset']);

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function basename(s){return String(s||'file.slk').split(/[\\/]/).pop();}
function baseNoExt(s){return basename(s).replace(/\.slk$/i,'');}
function docById(id){return docs.find(d=>d.id===id);}
function activeDoc(){return docById(activeId);}
function isRoot(d){return !!d && d.id===rootId;}
function normalize(s){return String(s??'').trim().toLocaleLowerCase();}

/* =====================================================================
   1:1 SLK ROW MODEL:
   d.records[0] = SLK Row 1 (Column Headers: SINGER, MUSIC NAME, etc.)
   d.records[1] = SLK Row 2 (Column Types: string, int, float, etc.)
   d.records[2..] = SLK Row 3+ (Song Entries)
   ===================================================================== */
function syncMetaFromRecords(d){
 if(!d||!d.records)return;
 const maxCols=Math.max(1,d.headers?.length||0,...d.records.slice(0,5).map(r=>r.length));
 if(d.records.length>=1){
  d.headers=Array.from({length:maxCols},(_,i)=>String(d.records[0][i]??`Column ${i+1}`));
 }
 if(d.records.length>=2){
  d.types=Array.from({length:maxCols},(_,i)=>{
   const raw=normalize(d.records[1][i]||'string');
   return (raw==='int'||raw==='float'||raw==='string')?raw:(raw.includes('int')?'int':raw.includes('float')?'float':'string');
  });
 }
 d.columnCount=d.headers.length;
 d.rowCount=d.records.length;
}
function isMetaRow(r){return r===0||r===1;}
function songStartIdx(d){return Math.min(2,d.records.length);}

function kindOf(d){
 const h=(d.headers||[]).map(x=>normalize(x));
 if(h.some(x=>x.includes('start madi')) || d.headers.length>=12) return 'root';
 if(h.some(x=>x==='hard' || x.includes('hard '))) return 'blockbeat';
 const fn=normalize(d.filename+' '+d.exportName);
 if(fn.includes('blockbeat')) return 'blockbeat';
 if(fn.includes('onetwo') || fn.includes('one two')) return 'onetwo';
 if(fn.includes('beatup')) return 'beatup';
 if(h.some(x=>x==='level') && d.headers.length===8) return 'onetwo';
 return 'custom';
}
function labelForKind(kind){return ({root:'Main list',beatup:'BeatUp',blockbeat:'BlockBeat',onetwo:'OneTwo',custom:'SLK'})[kind]||'SLK';}
function canonicalIndexes(d){
 const h=(d.headers||[]).map(normalize), kind=kindOf(d), idx={};
 const find=(pred)=>h.findIndex(pred);
 idx.singer=find(x=>['singer','artist','가수','°¡¼ö'].includes(x)||x.includes('singer'));
 idx.title=find(x=>['song name','music name','title','제목','Á¦¸ñ'].includes(x)||x.includes('song name')||x.includes('music name'));
 idx.filename=find(x=>x==='file name'||x==='filename'||x==='파일명'||x==='ÆÄÀÏ¸í'||x.includes('file name'));
 idx.bpm=find(x=>x==='bpm');
 idx.level=find(x=>x==='level'||x==='레벨'||x==='·¹º§');
 idx.offset=find(x=>x==='offset');
 idx.new=find(x=>x==='new'||x==='신규'||x==='½Å±Ô');
 idx.use=find(x=>x==='use'||x==='사용여부'||x==='»ç¿ë¿©ºÎ');
 idx.hard=find(x=>x==='hard');
 idx.startMadi=find(x=>x.includes('start madi'));
 idx.endMadi=find(x=>x.includes('end delete madi'));
 idx.info=find(x=>x==='info');
 idx.money=find(x=>x==='money');idx.cash=find(x=>x==='cash');idx.charge=find(x=>x==='charge');idx.bgm=find(x=>x==='bgm');idx.bgmMaster=find(x=>x==='bgmmaster');
 if(idx.singer<0)idx.singer=0;if(idx.title<0)idx.title=1;if(idx.filename<0)idx.filename=2;
 if(idx.bpm<0)idx.bpm=(kind==='root'?5:3);
 if(idx.offset<0)idx.offset=(kind==='root'?6:5);
 if(idx.use<0)idx.use=(kind==='root'?7:7);
 if(idx.new<0)idx.new=(kind==='root'?11:6);
 if(idx.level<0 && kind!=='root' && d.headers.length>=5)idx.level=4;
 return idx;
}
function getVal(d,row,field){const i=canonicalIndexes(d)[field];return i>=0&&i<row.length?String(row[i]??''):'';}
function findFieldIdx(d,field){return canonicalIndexes(d)[field]??-1;}
function identity(d,row){return [getVal(d,row,'singer'),getVal(d,row,'title'),getVal(d,row,'filename')].map(normalize).join('\u001f');}

function rowDefaults(d){
 return d.headers.map((head,i)=>{
  let t=normalize(d.types[i]||'string');
  if(i===findFieldIdx(d,'use')) return '1';
  if(i===findFieldIdx(d,'new')) return '1';
  if(i===findFieldIdx(d,'offset')) return '0.7';
  if(t==='string') return '';
  return '0';
 });
}

function parseTbmName(value){
 const match=String(value??'').trim().match(/^(.*?)(\d+)(\.tbm)$/i);
 return match?{prefix:match[1],number:Number(match[2]),width:match[2].length,suffix:match[3]}:null;
}
function availableTbmPrefixes(doc){
 const values=[];const index=findFieldIdx(doc,'filename');
 if(index>=0){
  for(let r=songStartIdx(doc);r<doc.records.length;r++){
   const parsed=parseTbmName(doc.records[r][index]);
   if(parsed&&!values.includes(parsed.prefix))values.push(parsed.prefix);
  }
 }
 return values;
}
function latestTbmPrefix(doc){
 const index=findFieldIdx(doc,'filename');if(index<0)return 'g';
 for(let i=doc.records.length-1;i>=songStartIdx(doc);i--){
  const parsed=parseTbmName(doc.records[i][index]);
  if(parsed)return parsed.prefix;
 }
 return 'g';
}
function highestTbmForPrefix(doc,prefix){
 const index=findFieldIdx(doc,'filename');if(index<0)return null;
 let best=null;
 for(let i=songStartIdx(doc);i<doc.records.length;i++){
  const parsed=parseTbmName(doc.records[i][index]);
  if(parsed&&parsed.prefix.toLowerCase()===String(prefix).toLowerCase()){
   if(!best||parsed.number>=best.number)best=parsed;
  }
 }
 return best;
}
function nextTbmFilename(doc,prefix,offset=0){
 const cleanPrefix=prefix||latestTbmPrefix(doc)||'g';
 const latest=highestTbmForPrefix(doc,cleanPrefix);
 const width=latest?.width||4;
 const suffix=latest?.suffix||'.tbm';
 const number=(latest?latest.number:1000)+1+offset;
 return `${latest?latest.prefix:cleanPrefix}${String(number).padStart(width,'0')}${suffix}`;
}
function incrementTbmFilename(filename,prefix,doc,offset=0){
 const parsed=parseTbmName(filename);
 if(parsed){
  const high=highestTbmForPrefix(doc,parsed.prefix);
  const base=Math.max(parsed.number,high?high.number:0);
  return `${parsed.prefix}${String(base+1+offset).padStart(parsed.width,'0')}${parsed.suffix}`;
 }
 return nextTbmFilename(doc,prefix,offset);
}
function newEntrySeed(doc,filename,refRowIdx=null){
 const row=rowDefaults(doc);
 const offsetIndex=findFieldIdx(doc,'offset'),newIndex=findFieldIdx(doc,'new'),useIndex=findFieldIdx(doc,'use'),filenameIndex=findFieldIdx(doc,'filename');
 const singerIndex=findFieldIdx(doc,'singer'),titleIndex=findFieldIdx(doc,'title'),levelIndex=findFieldIdx(doc,'level');
 if(singerIndex>=0)row[singerIndex]='';
 if(titleIndex>=0)row[titleIndex]='';
 if(offsetIndex>=0)row[offsetIndex]='0.7';
 if(newIndex>=0)row[newIndex]='1';
 if(useIndex>=0)row[useIndex]='1';
 if(levelIndex>=0)row[levelIndex]=String(doc.targetLevel??'3');
 if(filenameIndex>=0)row[filenameIndex]=filename||nextTbmFilename(doc,latestTbmPrefix(doc),0);
 return row;
}

function prefixValue(){
 const selected=$('#tbmPrefixSelect')?.value||selectedTbmPrefix;
 if(selected==='__custom__')return String($('#tbmCustomPrefix')?.value||'g').trim();
 return selected;
}
function setDraftFilename(draft,doc,filename){const i=findFieldIdx(doc,'filename');if(i>=0)draft[i]=filename;}
function collectEntryDrafts(){
 const doc=docById(rootId)||activeDoc();if(!doc)return;
 $$('#entryList [data-add-col]').forEach(input=>{const i=Number(input.dataset.entryIndex),col=Number(input.dataset.addCol);if(entryDrafts[i])entryDrafts[i][col]=input.value;});
 $$('#entryList [data-entry-level]').forEach(input=>{const i=Number(input.dataset.entryIndex),id=input.dataset.targetId;if(entryTargetLevels[i])entryTargetLevels[i][id]=String(Math.max(0,Number(input.value)||0));});
}
function updateEntrySaveLabel(){const button=$('#saveEntriesBtn');if(button)button.textContent=`Add ${entryDrafts.length} entr${entryDrafts.length===1?'y':'ies'}`;const count=$('#entryCount');if(count)count.textContent=`${entryDrafts.length} entr${entryDrafts.length===1?'y':'ies'}`;}
function renderTbmPrefixOptions(doc,preferred=''){
 const select=$('#tbmPrefixSelect');if(!select)return;
 const prefixes=availableTbmPrefixes(doc);const inferred=preferred||latestTbmPrefix(doc)||'g';
 if(!prefixes.includes(inferred))prefixes.push(inferred);
 if(!prefixes.length)prefixes.push('g');
 select.innerHTML=prefixes.map(prefix=>`<option value="${esc(prefix)}">${esc(prefix)} · ${esc(nextTbmFilename(doc,prefix))}</option>`).join('')+'<option value="__custom__">Custom prefix…</option>';
 if(prefixes.includes(inferred)){select.value=inferred;$('#customPrefixField').hidden=true;}else{select.value='__custom__';$('#customPrefixField').hidden=false;$('#tbmCustomPrefix').value=inferred;}
 selectedTbmPrefix=inferred;
}
function recalculateEntryFilenames(){
 const doc=docById(rootId)||activeDoc();if(!doc||!entryDrafts.length)return;
 const prefix=prefixValue();if(!prefix){toast('Enter a TBM prefix first.','error');return;}
 selectedTbmPrefix=prefix;
 entryDrafts.forEach((draft,index)=>setDraftFilename(draft,doc,nextTbmFilename(doc,prefix,index)));
 renderEntryDrafts();
}
function makeTargetRow(sourceDoc,sourceRow,targetDoc,targetLevelOverride=null){
 const out=rowDefaults(targetDoc);
 for(const f of ['singer','title','filename']){
  const si=findFieldIdx(sourceDoc,f),ti=findFieldIdx(targetDoc,f);
  if(si>=0&&ti>=0)out[ti]=String(sourceRow[si]??'');
 }
 for(const f of syncFieldKeys){
  const si=findFieldIdx(sourceDoc,f),ti=findFieldIdx(targetDoc,f);
  if(si>=0&&ti>=0)out[ti]=String(sourceRow[si]??'');
 }
 const levelIdx=findFieldIdx(targetDoc,'level');if(levelIdx>=0)out[levelIdx]=String(targetLevelOverride??targetDoc.targetLevel??'3');
 const newIdx=findFieldIdx(targetDoc,'new'),useIdx=findFieldIdx(targetDoc,'use');
 if(newIdx>=0)out[newIdx]='1';if(useIdx>=0)out[useIdx]='1';
 const offsetIdx=findFieldIdx(targetDoc,'offset');if(offsetIdx>=0&&!syncFieldKeys.has('offset'))out[offsetIdx]='0.7';else if(offsetIdx>=0&&String(out[offsetIdx]??'').trim()==='')out[offsetIdx]='0.7';
 return out;
}
function upsertToTarget(sourceDoc,sourceRow,targetDoc,targetLevelOverride=null,options={}){
 const ident=identity(sourceDoc,sourceRow);
 let found=-1;
 for(let i=songStartIdx(targetDoc);i<targetDoc.records.length;i++){
  if(identity(targetDoc,targetDoc.records[i])===ident){found=i;break;}
 }
 if(found<0&&options.matchByTrack){
  const key=trackIdentity(sourceDoc,sourceRow),matches=[];
  if(key!=='\u001f')for(let i=songStartIdx(targetDoc);i<targetDoc.records.length;i++)if(trackIdentity(targetDoc,targetDoc.records[i])===key)matches.push(i);
  if(matches.length===1)found=matches[0];
 }
 if(found>=0){
  const current=targetDoc.records[found].slice();let changed=false;
  for(const f of syncFieldKeys){
   const ti=findFieldIdx(targetDoc,f),si=findFieldIdx(sourceDoc,f);
   if(ti>=0&&si>=0){const value=String(sourceRow[si]??'');if(String(current[ti]??'')!==value){current[ti]=value;changed=true;}}
  }
  if(changed){targetDoc.records[found]=current;dirty.add(targetDoc.id);targetDoc.rowCount=targetDoc.records.length;return 'updated';}
  return 'unchanged';
 }
 targetDoc.records.push(makeTargetRow(sourceDoc,sourceRow,targetDoc,targetLevelOverride));targetDoc.rowCount=targetDoc.records.length;dirty.add(targetDoc.id);return 'added';
}
function markDirty(d){syncMetaFromRecords(d);dirty.add(d.id);}

/* Full-state snapshot Undo/Redo (supports cell edits, row insertions/deletions, and column insertions/deletions) */
function beginUndo(label, affectedDocs){
 const list=[...new Map((affectedDocs||[]).filter(Boolean).map(d=>[d.id,d])).values()];
 return {
  label,
  snapshots:list.map(d=>({
   id:d.id,
   headers:d.headers.slice(),
   types:d.types.slice(),
   colW:d.colW?d.colW.slice():null,
   records:d.records.map(r=>r.slice())
  }))
 };
}
function commitUndo(transaction){
 if(!transaction)return;
 const entries=[];
 for(const snap of transaction.snapshots){
  const d=docById(snap.id);if(!d)continue;
  const sameCols=snap.headers.length===d.headers.length&&snap.headers.every((h,i)=>h===d.headers[i])&&snap.types.every((t,i)=>t===d.types[i]);
  const sameRows=snap.records.length===d.records.length&&snap.records.every((r,i)=>rowsEqual(r,d.records[i]));
  if(sameCols&&sameRows)continue;
  entries.push({
   id:d.id,
   before:{headers:snap.headers,types:snap.types,colW:snap.colW,records:snap.records},
   after:{headers:d.headers.slice(),types:d.types.slice(),colW:d.colW?d.colW.slice():null,records:d.records.map(r=>r.slice())}
  });
 }
 if(!entries.length)return;
 undoStack.push({label:transaction.label,entries});
 if(undoStack.length>50)undoStack.shift();
 redoStack=[];
}
function rowsEqual(a,b){if(a===null||b===null)return a===b;if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;return a.every((v,i)=>String(v??'')===String(b[i]??''));}

function applyHistory(sourceStack,targetStack,verb){
 const item=sourceStack.pop();if(!item){toast(verb==='Undo'?'Nothing to undo.':'Nothing to redo.');return;}
 const forward=verb==='Redo';
 let touched=0;
 if(item.entries){
  for(const entry of item.entries){
   const d=docById(entry.id);if(!d)continue;
   const state=forward?entry.after:entry.before;
   d.headers=state.headers.slice();
   d.types=state.types.slice();
   d.colW=state.colW?state.colW.slice():null;
   d.records=state.records.map(r=>r.slice());
   markDirty(d);
   if(gridById[d.id])gridById[d.id].sig='';
   touched++;
  }
 }else if(item.patches){
  for(const patch of item.patches){
   const d=docById(patch.id);if(!d)continue;
   const val=forward?patch.after:patch.before;
   if(val&&patch.row<d.records.length)d.records[patch.row]=val.slice();
   markDirty(d);
   if(gridById[d.id])gridById[d.id].sig='';
   touched++;
  }
 }
 if(!touched){toast('The files for this history action are no longer loaded.','error');return;}
 targetStack.push(item);viewStamp++;renderAll();toast(`${verb==='Undo'?'Undid':'Redid'}: ${item.label}.`);
}
function undoEdit(){applyHistory(undoStack,redoStack,'Undo');}
function redoEdit(){applyHistory(redoStack,undoStack,'Redo');}
function makeId(){return (globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():`doc_${Date.now()}_${Math.random().toString(16).slice(2)}`;}

/* ---------- SLK byte decoding + tolerant SYLK parser ---------- */
function detectLegacySlkEncoding(bytes){
 // Western encodings usually have isolated accented bytes, while CP949 text
 // is predominantly made of adjacent two-byte sequences.
 let pairedHigh=0,singleHigh=0;
 for(let i=0;i<bytes.length;i++){
  if(bytes[i]<0x80)continue;
  if(i+1<bytes.length&&bytes[i+1]>=0x80){pairedHigh++;i++;}
  else singleHigh++;
 }
 try{
  const korean=window.PochitaCP949?.decode
   ? window.PochitaCP949.decode(bytes)
   : new TextDecoder('euc-kr',{fatal:true}).decode(bytes);
  if(/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(korean))return 'cp949';
  // A single high-byte pair can occur in Western words such as “Größe”.
  // Require multiple pairs before treating non-Hangul legacy text as CP949.
  if(pairedHigh>=2&&pairedHigh>singleHigh)return 'cp949';
 }catch(_){/* Fall through to the Western decoder. */}
 return 'windows-1252';
}
function decodeSlkBytes(raw){
 const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw||0);
 if(!bytes.length)return {text:'',encoding:'utf-8'};
 let encoding='';let offset=0;
 // BOMs are authoritative and are removed before decoding.
 if(bytes.length>=3&&bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF){encoding='utf-8-sig';offset=3;}
 else if(bytes.length>=2&&bytes[0]===0xFF&&bytes[1]===0xFE){encoding='utf-16le';offset=2;}
 else if(bytes.length>=2&&bytes[0]===0xFE&&bytes[1]===0xFF){encoding='utf-16be';offset=2;}
 else{
  // Detect BOM-less UTF-16 from the alternating NUL-byte pattern typical of
  // ASCII-heavy SYLK records (ID;P..., C;X..., etc.).
  const n=Math.min(bytes.length,256);let evenZero=0,oddZero=0;
  for(let i=0;i<n;i++)if(bytes[i]===0){if(i&1)oddZero++;else evenZero++;}
  if(n>=4&&oddZero>=2&&oddZero>n*0.18&&oddZero>evenZero*3)encoding='utf-16le';
  else if(n>=4&&evenZero>=2&&evenZero>n*0.18&&evenZero>oddZero*3)encoding='utf-16be';
  else{
   try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);encoding='utf-8';}
   catch(_){encoding=detectLegacySlkEncoding(bytes);}
  }
 }
 const payload=bytes.subarray(offset);
 let text;
 try{
  if(encoding==='cp949')text=window.PochitaCP949?.decode?window.PochitaCP949.decode(payload):new TextDecoder('euc-kr').decode(payload);
  else text=new TextDecoder(encoding==='utf-8-sig'?'utf-8':encoding).decode(payload);
 }catch(error){
  if(encoding==='cp949'){
   // A malformed/ambiguous CP949 stream is still recoverable as Western text.
   encoding='windows-1252';text=new TextDecoder('windows-1252').decode(payload);
  }else throw new Error(`Could not decode SLK file as ${encoding}: ${error.message}`);
 }
 return {text:text.replace(/^\uFEFF/,''),encoding};
}
function splitSylkTokens(line){
 const tokens=[];let current='',quoted=false;
 for(let i=0;i<line.length;i++){
  const ch=line[i],next=line[i+1];
  if(ch==='"'){
   if(quoted&&next==='"'){current+='"';i++;}
   else{quoted=!quoted;current+=ch;}
  }else if(ch===';'&&next===';'){
   // SYLK escapes a literal semicolon by doubling it.
   current+=';';i++;
  }else if(ch===';'&&!quoted){tokens.push(current);current='';}
  else current+=ch;
 }
 tokens.push(current);return tokens;
}
function parseSylkValue(raw){
 const value=String(raw??'').trim();
 return value.length>=2&&value[0]==='"'&&value[value.length-1]==='"'
  ? value.slice(1,-1).replace(/""/g,'"') : value;
}
function parseTsvFallback(text){
 const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(line=>line.length>0);
 if(!lines.length)throw new Error('The selected file is empty.');
 const records=lines.map(line=>line.split('\t'));
 const width=Math.max(1,...records.map(row=>row.length));
 records.forEach(row=>{while(row.length<width)row.push('');});
 if(records.length===1)records.push(Array(width).fill('string'));
 return records;
}
function parseSlk(name,raw){
 const decoded=decodeSlkBytes(raw),text=decoded.text,newline=text.includes('\r\n')?'\r\n':(text.includes('\r')?'\r':'\n');
 const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
 const idLine=lines.find(line=>line.trimStart().startsWith('ID;'))||'ID;PCALCOOO32';
 const endLine=[...lines].reverse().find(line=>line.trim()==='E')||'E';
 const cells=new Map();let currentX=1,currentY=1,maxRow=0,maxCol=0,cellCount=0;
 for(const rawLine of lines){
  if(!rawLine.trim())continue;
  const tokens=splitSylkTokens(rawLine.trimStart());
  const recordType=String(tokens[0]||'').trim().toUpperCase();
  if(recordType==='E')break;
  if(recordType==='B')continue; // Bounds are advisory; only populated cells size the grid.
  if(recordType!=='C')continue;
  let hasValue=false,value='';
  // X and Y are sticky in SYLK. Keep the previous coordinate when a record
  // omits it, and accept either X/Y token order.
  for(let i=1;i<tokens.length;i++){
   const token=tokens[i];if(!token)continue;
   const coord=/^([XY])(\d+)$/i.exec(token.trim());
   if(coord){
    const n=Number(coord[2]);
    if(Number.isSafeInteger(n)&&n>=1){if(coord[1].toUpperCase()==='X')currentX=n;else currentY=n;}
   }else if(token[0].toUpperCase()==='K'){
    hasValue=true;value=parseSylkValue(token.slice(1));
   }
  }
  if(!hasValue||currentX<1||currentY<1)continue;
  let row=cells.get(currentY);if(!row){row=new Map();cells.set(currentY,row);}
  row.set(currentX,value);cellCount++;
  maxRow=Math.max(maxRow,currentY);maxCol=Math.max(maxCol,currentX);
 }
 let records=[];
 if(cellCount){
  // Row 1 (headers) and Row 2 (types) are always present in the editor model.
  const rowCount=Math.max(2,maxRow),width=Math.max(1,maxCol);
  records=Array.from({length:rowCount},(_,r)=>Array.from({length:width},(_,c)=>cells.get(r+1)?.get(c+1)??(r===1?'string':'')));
  while(records.length>2&&!records[records.length-1].some(v=>String(v).trim()))records.pop();
 }else if(text.includes('\t'))records=parseTsvFallback(text);
 else throw new Error(`${name}: No valid SYLK cells found. The file may be damaged or use an unsupported format.`);
 const headers=Array.from({length:Math.max(1,...records.map(r=>r.length))},(_,i)=>String(records[0]?.[i]??`Column ${i+1}`));
 const types=Array.from({length:headers.length},(_,i)=>String(records[1]?.[i]??'string'));
 const doc={id:makeId(),filename:basename(name),exportName:basename(name),encoding:decoded.encoding,newline,idLine,endLine,headers,types,records,rowCount:records.length,columnCount:headers.length};
 syncMetaFromRecords(doc);return doc;
}

function quoteSlk(value){return '"'+String(value??'').replace(/"/g,'""')+'"';}
function numericSlk(value,kind,rowNo,colNo){
 let raw=String(value??'').trim();if(!raw)raw='0';raw=raw.replace(/,/g,'.');const number=Number(raw);
 if(!Number.isFinite(number))throw new Error(`Row ${rowNo}, column ${colNo}: “${value}” is not a valid number.`);
 if(String(kind).toLowerCase()==='int')return String(Math.trunc(number));
 return String(Number(number.toPrecision(12)));
}
function encodeWindows1252(text){
 const special=[0x20AC,0x0081,0x201A,0x0192,0x201E,0x2026,0x2020,0x2021,0x02C6,0x2030,0x0160,0x2039,0x0152,0x008D,0x017D,0x008F,0x0090,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x02DC,0x2122,0x0161,0x203A,0x0153,0x009D,0x017E,0x0178];
 const reverse=new Map(special.map((cp,i)=>[cp,0x80+i]));const out=[];
 for(const ch of String(text)){
  const cp=ch.codePointAt(0);
  if(cp<=0x7F||(cp>=0xA0&&cp<=0xFF))out.push(cp);
  else if(reverse.has(cp))out.push(reverse.get(cp));
  else throw new Error(`Character ${JSON.stringify(ch)} cannot be represented in Windows-1252. Export cancelled to avoid damaging the file.`);
 }
 return Uint8Array.from(out);
}
function encodeUtf16(text,littleEndian=true){
 const out=new Uint8Array(2+String(text).length*2);out[0]=littleEndian?0xFF:0xFE;out[1]=littleEndian?0xFE:0xFF;
 const view=new DataView(out.buffer);
 for(let i=0;i<String(text).length;i++)view.setUint16(2+i*2,String(text).charCodeAt(i),littleEndian);
 return out;
}
function encodeSlkText(text,encoding){
 const enc=String(encoding||'utf-8').toLowerCase();
 if(enc==='utf-8-sig'){const body=new TextEncoder().encode(text),out=new Uint8Array(body.length+3);out.set([0xEF,0xBB,0xBF]);out.set(body,3);return out;}
 if(enc==='utf-8')return new TextEncoder().encode(text);
 if(enc==='utf-16'||enc==='utf-16le')return encodeUtf16(text,true);
 if(enc==='utf-16be')return encodeUtf16(text,false);
 if(enc==='cp949')return window.PochitaCP949.encode(text);
 if(enc==='windows-1252'||enc==='windows1252'||enc==='cp1252')return encodeWindows1252(text);
 throw new Error(`Unsupported source encoding “${encoding}”. Export cancelled to avoid damaging the file.`);
}
function serializeDoc(doc){
 syncMetaFromRecords(doc);
 const width=doc.headers.length;if(!width)throw new Error('This SLK file has no columns.');
 const types=([...(doc.types||[]),...Array(width).fill('string')]).slice(0,width);
 const lines=[doc.idLine||'ID;PCALCOOO32'];
 const rows=doc.records||[];
 rows.forEach((row,y)=>{
  const values=[...(row||[]),...Array(width).fill('')].slice(0,width);
  values.forEach((value,x)=>{
   const kind=String(types[x]||'string').toLowerCase();
   let encoded;
   if(y<2||kind==='string')encoded=quoteSlk(value);
   else encoded=numericSlk(value,kind,y+1,x+1);
   lines.push(`C;X${x+1};Y${y+1};K${encoded}`);
  });
 });
 lines.push(doc.endLine||'E');
 return encodeSlkText(lines.join(doc.newline||'\r\n')+(doc.newline||'\r\n'),doc.encoding||'cp949');
}
function downloadBytes(bytes,name,mime='application/octet-stream'){
 const blob=new Blob([bytes],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function syncFieldOptions(){
 const root=docById(rootId);if(!root)return [];
 const targets=docs.filter(d=>d.id!==rootId);
 return SYNC_FIELD_CANDIDATES.filter(f=>findFieldIdx(root,f.key)>=0&&targets.some(d=>findFieldIdx(d,f.key)>=0));
}
function defaultSyncFieldKeys(){return new Set(syncFieldOptions().filter(f=>DEFAULT_SYNC_FIELD_KEYS.has(f.key)).map(f=>f.key));}
function toast(message,kind='ok'){
 const node=document.createElement('div');node.className='toast';node.innerHTML=`<span class="toast-mark">${kind==='error'?'!':'✓'}</span><span>${esc(message)}</span>`;$('#toastWrap').append(node);setTimeout(()=>node.remove(),4800);
}
function updateStatus(text){$('#statusText').textContent=text;}
function targetDocs(){return docs.filter(d=>d.id!==rootId&&d.syncTarget);}

/* =====================================================================
   Spreadsheet workspace: ribbon, virtual grid, keyboard model
   ===================================================================== */
const ROW_H = {comfortable: 24, compact: 20};
const HDR1_H = 20, HDR2_H = 26, ROWNUM_W = 54, FREEZE_N = 2, OVERSCAN = 14, MIN_COL = 44, MAX_AUTO = 340;
const rowHeight = () => compactMode ? ROW_H.compact : ROW_H.comfortable;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function colName(i){let s='';i=i+1;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;}
function colIndexFromName(s){let n=0;for(const ch of s.toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n-1;}
function typeOf(d,c){return normalize(d.types[c]||'string');}
function isNumericCol(d,c){const t=typeOf(d,c);return t==='int'||t==='float';}
function typeTag(d,c){const t=typeOf(d,c);return t==='int'?'int':t==='float'?'float':'text';}
function fmtInt(n){return Number(n).toLocaleString('en-US');}

/* ---------- row view (filter) ---------- */
const viewCache = new Map();
function getView(d){
 const q=normalize(query);
 if(!q)return {n:d.records.length,idx:null,at:p=>p,posOf:r=>(r>=0&&r<d.records.length)?r:-1};
 const key=q+'\u0001'+d.records.length+'\u0001'+viewStamp,cached=viewCache.get(d.id);
 if(cached&&cached.key===key)return cached.view;
 const idx=[];
 for(let i=0;i<d.records.length;i++){
  const row=d.records[i];
  for(let j=0;j<row.length;j++){if(normalize(row[j]).includes(q)){idx.push(i);break;}}
 }
 const map=new Map(idx.map((r,p)=>[r,p]));
 const view={n:idx.length,idx,at:p=>idx[p],posOf:r=>map.has(r)?map.get(r):-1};
 viewCache.set(d.id,{key,view});return view;
}

/* ---------- selection model (positions in the filtered view) ---------- */
function selOf(id){return selById[id]||(selById[id]={a:{p:0,c:0},f:{p:0,c:0},extra:[]});}
function rangeOf(s){return {p1:Math.min(s.a.p,s.f.p),p2:Math.max(s.a.p,s.f.p),c1:Math.min(s.a.c,s.f.c),c2:Math.max(s.a.c,s.f.c)};}
function allRanges(s){return [...s.extra,rangeOf(s)];}
function clampSel(d){
 const s=selOf(d.id),v=getView(d),maxP=Math.max(0,v.n-1),maxC=Math.max(0,d.headers.length-1);
 const cl=pt=>{pt.p=clamp(pt.p,0,maxP);pt.c=clamp(pt.c,0,maxC);};cl(s.a);cl(s.f);
 s.extra=s.extra.map(r=>({p1:Math.min(r.p1,maxP),p2:Math.min(r.p2,maxP),c1:Math.min(r.c1,maxC),c2:Math.min(r.c2,maxC)}));
}
function selectedModelRows(d){
 const s=selOf(d.id),v=getView(d),set=new Set();
 for(const rg of allRanges(s))for(let p=rg.p1;p<=rg.p2&&p<v.n;p++)set.add(v.at(p));
 return [...set].sort((a,b)=>a-b);
}
function activeCellInfo(d){
 const v=getView(d);if(!d||!v.n)return null;const s=selOf(d.id),p=Math.min(s.a.p,v.n-1),r=v.at(p);
 return {p,r,c:s.a.c,value:String(d.records[r]?.[s.a.c]??'')};
}

/* ---------- column widths ---------- */
let measureCtx=null;
function measureText(text,bold){
 if(!measureCtx)measureCtx=document.createElement('canvas').getContext('2d');
 measureCtx.font=`${bold?'600 ':''}12px ${getComputedStyle(document.body).fontFamily}`;
 return measureCtx.measureText(text).width;
}
function autoFitWidths(d,only=null){
 const out=[],n=d.records.length,step=Math.max(1,Math.floor(n/500));
 for(let c=0;c<d.headers.length;c++){
  if(only!==null&&only!==c){out.push(d.colW[c]);continue;}
  let w=measureText(d.headers[c]||`Column ${c+1}`,true)+58;
  for(let r=0;r<n;r+=step){const v=d.records[r][c];if(v)w=Math.max(w,measureText(String(v))+20);}
  out.push(Math.round(clamp(w,MIN_COL,MAX_AUTO)));
 }
 return out;
}
const widthKey=d=>'pochita-colw:'+d.headers.join('|');
function widthsOf(d){
 if(d.colW&&d.colW.length===d.headers.length)return d.colW;
 let saved=null;try{saved=JSON.parse(localStorage.getItem(widthKey(d)));}catch(_){}
 d.colW=(Array.isArray(saved)&&saved.length===d.headers.length&&saved.every(x=>Number(x)>=MIN_COL))?saved.map(Number):autoFitWidths(d);
 return d.colW;
}
function saveWidths(d){try{localStorage.setItem(widthKey(d),JSON.stringify(d.colW));}catch(_){}}
function colLeft(d,c){const w=widthsOf(d);let x=ROWNUM_W;for(let i=0;i<c;i++)x+=w[i];return x;}
function frozenWidth(d){const w=widthsOf(d);let x=ROWNUM_W;if(freezeCols)for(let i=0;i<Math.min(FREEZE_N,w.length);i++)x+=w[i];return x;}

/* ---------- grid instances ---------- */
function makeGrid(d){
 const el=document.createElement('article');el.className='sheet-card';el.dataset.card=d.id;
 el.innerHTML=`<div class="sheet-card-head"></div><div class="grid-scroll"><div class="grid-inner"><table class="grid"><colgroup></colgroup><thead></thead><tbody></tbody></table><div class="grid-add-bar"><button type="button" class="grid-add-btn" data-act="quick-row" title="Append a new row at the bottom with auto-TBM (Ctrl+Enter)"><span class="plus">＋</span><span>Add new row</span></button><button type="button" class="grid-add-btn" data-act="modal-entry" title="Open the New Entry dialog for Root &amp; Targets"><span class="plus">✦</span><span>New entry (Root &amp; Targets)…</span></button><span class="grid-add-hint">Auto-increments TBM · Offset 0.7 · NEW &amp; USE = 1</span></div><input class="cell-editor" type="text" spellcheck="false" autocomplete="off" aria-label="Active cell"></div><div class="grid-empty" hidden></div></div>`;
 const q=s=>el.querySelector(s);
 const g={id:d.id,el,head:q('.sheet-card-head'),scroller:q('.grid-scroll'),inner:q('.grid-inner'),table:q('table.grid'),colgroup:q('colgroup'),thead:q('thead'),tbody:q('tbody'),editor:q('.cell-editor'),empty:q('.grid-empty'),
  rf:-1,rl:-1,n:-1,rowH:rowHeight(),theadH:HDR1_H+HDR2_H,st:0,sl:0,tabStart:null,sig:'',raf:0,base:[]};
 el.querySelector('[data-act="quick-row"]').addEventListener('click',e=>{e.stopPropagation();setActiveDoc(d.id);appendRowAtBottom(d);});
 el.querySelector('[data-act="modal-entry"]').addEventListener('click',e=>{e.stopPropagation();setActiveDoc(d.id);openModal();});
 g.scroller.addEventListener('scroll',()=>{if(g.raf)return;g.raf=requestAnimationFrame(()=>{g.raf=0;renderViewport(g);if(freezeCols)placeEditor(g);});},{passive:true});
 g.scroller.addEventListener('mousedown',e=>onGridMouseDown(g,e));
 g.scroller.addEventListener('contextmenu',e=>onGridContextMenu(g,e));
 g.scroller.addEventListener('dblclick',e=>onGridDblClick(g,e));
 g.editor.addEventListener('keydown',e=>onEditorKeydown(g,e));
 g.editor.addEventListener('input',()=>onEditorInput(g));
 g.editor.addEventListener('compositionstart',()=>{if(!edit)beginEdit(g,'enter',{value:''});});
 g.editor.addEventListener('blur',()=>setTimeout(()=>{if(edit&&edit.g===g&&edit.source==='cell'&&document.activeElement!==g.editor&&document.activeElement!==$('#formulaInput'))commitEdit(null,{refocus:false});},0));
 gridById[d.id]=g;return g;
}
function appendRowAtBottom(d){
 d=d||activeDoc();if(!d)return;
 if(edit&&!commitEdit(null,{refocus:false}))return;
 const prefix=latestTbmPrefix(d)||'g';
 const tbm=nextTbmFilename(d,prefix,0);
 const newRow=newEntrySeed(d,tbm,null);
 const history=beginUndo('Append song row',[d]);
 d.records.push(newRow);
 markDirty(d);
 commitUndo(history);
 if(query){query='';$('#searchInput').value='';}
 viewStamp++;
 renderAll();
 gotoRow(d.id,d.records.length-1,0);
 focusGrid();
 toast(`Added Row ${d.records.length} (${tbm}).`);
}
function activeGrid(){return gridById[activeId]&&gridById[activeId].el.isConnected?gridById[activeId]:null;}
function frozenLefts(d){const w=widthsOf(d),out=[];let x=ROWNUM_W;for(let i=0;i<Math.min(FREEZE_N,w.length);i++){out.push(x);x+=w[i];}return out;}
function buildHead(g,d){
 const w=widthsOf(d),sig=w.join(',')+'|'+freezeCols+'|'+d.headers.join('|')+'|'+d.types.join('|');
 if(g.sig===sig)return;g.sig=sig;
 g.table.style.width=(ROWNUM_W+w.reduce((a,b)=>a+b,0))+'px';
 g.colgroup.innerHTML=`<col style="width:${ROWNUM_W}px">`+w.map(x=>`<col style="width:${x}px">`).join('');
 const lefts=frozenLefts(d);let l1='<tr class="hl"><th class="corner" rowspan="2" data-corner title="Select all (Ctrl+A)"></th>',l2='<tr class="hn">';
 g.base=[];
 for(let c=0;c<d.headers.length;c++){
  const fz=freezeCols&&c<FREEZE_N,st=fz?` style="left:${lefts[c]}px"`:'',name=d.headers[c]||`Column ${c+1}`;
  g.base[c]=(isNumericCol(d,c)?'n':'')+(fz?' fz':'');
  l1+=`<th class="ch${fz?' fz':''}" data-c="${c}"${st}><span>${colName(c)}</span><i class="rz" data-rz="${c}"></i></th>`;
  l2+=`<th class="cn${fz?' fz':''}" data-c="${c}"${st} title="${esc(name)} · ${typeTag(d,c)}"><span class="nm">${esc(name)}</span><span class="ty">${typeTag(d,c)}</span><i class="rz" data-rz="${c}"></i></th>`;
 }
 g.thead.innerHTML=l1+'</tr>'+l2+'</tr>';
 g.theadH=g.thead.offsetHeight||(HDR1_H+HDR2_H);
}

/* ---------- virtual rendering (1:1 SLK row numbers: r+1) ---------- */
function renderViewport(g,force=false){
 const d=docById(g.id);if(!d)return false;
 const v=getView(d),n=v.n,rh=g.rowH,sc=g.scroller,ch=sc.clientHeight||500,st=sc.scrollTop;
 const vf=Math.max(0,Math.floor(st/rh)-1),vl=Math.max(0,Math.min(n-1,Math.ceil((st+ch)/rh)));
 if(!force&&g.rf>=0&&g.n===n&&vf>=g.rf+(g.rf>0?3:0)&&vl<=g.rl-(g.rl<n-1?3:0))return false;
 const rf=Math.max(0,vf-OVERSCAN),rl=Math.min(n-1,vl+OVERSCAN),cols=d.headers.length,lefts=frozenLefts(d),useIdx=findFieldIdx(d,'use');
 if(!g.base.length)buildHead(g,d);
 let html='';
 if(n>0&&rf>0)html+=`<tr class="sp" style="height:${rf*rh}px"><td colspan="${cols+1}"></td></tr>`;
 for(let p=rf;p<=rl&&n>0;p++){
  const r=v.at(p),row=d.records[r];if(!row)continue;
  const ina=!isMetaRow(r)&&useIdx>=0&&String(row[useIdx]??'').trim()==='0';
  const rowCls=r===0?'meta-hdr':r===1?'meta-type':(ina?'ina':'');
  html+=`<tr data-p="${p}" data-r="${r}"${rowCls?` class="${rowCls}"`:''}><th class="rh" scope="row" title="${r===0?'SLK Row 1 (Headers)':r===1?'SLK Row 2 (Types)':`SLK Row ${r+1}`}">${r+1}</th>`;
  for(let c=0;c<cols;c++){
   const fz=freezeCols&&c<FREEZE_N;
   const cellCls=isMetaRow(r)?(fz?'fz':''):g.base[c];
   html+=`<td data-c="${c}"${cellCls?` class="${cellCls}"`:''}${fz?` style="left:${lefts[c]}px"`:''}>${esc(row[c])}</td>`;
  }
  html+='</tr>';
 }
 if(n>0&&rl<n-1)html+=`<tr class="sp" style="height:${(n-1-rl)*rh}px"><td colspan="${cols+1}"></td></tr>`;
 g.tbody.innerHTML=html;g.rf=rf;g.rl=rl;g.n=n;
 g.empty.hidden=n>0;
 if(!n)g.empty.textContent=d.records.length?'No rows match the filter.':'This file has no rows yet — use New entry on the Home tab.';
 paintGrid(g);return true;
}
function paintGrid(g){
 const d=docById(g.id);if(!d)return;
 const s=selOf(d.id),ranges=allRanges(s),a=s.a,cols=d.headers.length,colOn=new Array(cols).fill(0);
 for(const r of ranges)for(let c=r.c1;c<=r.c2&&c<cols;c++)colOn[c]=1;
 if(a.c<cols)colOn[a.c]=2;
 for(const th of g.thead.querySelectorAll('th[data-c]')){
  const c=+th.dataset.c,cls=(th.classList.contains('ch')?'ch':'cn')+(th.classList.contains('fz')?' fz':'')+(colOn[c]?' on':'')+(colOn[c]===2?' act':'');
  if(th.className!==cls)th.className=cls;
 }
 const corner=g.thead.querySelector('.corner');if(corner)corner.classList.toggle('on',!!d.records.length&&ranges.length===1&&ranges[0].p1===0&&ranges[0].c1===0&&ranges[0].c2===cols-1&&ranges[0].p2===getView(d).n-1&&getView(d).n>1);
 for(const tr of g.tbody.rows){
  if(tr.classList.contains('sp'))continue;
  const p=+tr.dataset.p,rIdx=+tr.dataset.r,isAct=p===a.p;let rowIn=false;
  for(const r of ranges)if(p>=r.p1&&p<=r.p2){rowIn=true;break;}
  const rh=tr.cells[0],rcls='rh'+(rowIn?' on':'')+(isAct?' act':'');if(rh.className!==rcls)rh.className=rcls;
  const baseTr=rIdx===0?'meta-hdr':rIdx===1?'meta-type':(tr.classList.contains('ina')?'ina':'');
  const trc=(baseTr+(crosshair&&isAct?' xr':'')).trim();if(tr.className!==trc)tr.className=trc;
  for(let i=1;i<tr.cells.length;i++){
   const td=tr.cells[i],c=i-1;
   let cls=isMetaRow(rIdx)?(freezeCols&&c<FREEZE_N?'fz':''):(g.base[c]||'');
   if(rowIn){let inR=false,e='';
    for(const r of ranges){if(p>=r.p1&&p<=r.p2&&c>=r.c1&&c<=r.c2){inR=true;if(p===r.p1)e+=' et';if(p===r.p2)e+=' eb';if(c===r.c1)e+=' el';if(c===r.c2)e+=' er';}}
    if(inR)cls+=' s'+e;}
   if(isAct&&c===a.c)cls+=' a';else if(crosshair&&(isAct||c===a.c))cls+=' x';
   cls=cls.trim();if(td.className!==cls)td.className=cls;
  }
 }
}
function paintAll(){for(const g of Object.values(gridById))if(g.el.isConnected)paintGrid(g);}
function placeEditor(g){
 const d=docById(g.id),ed=g.editor;if(!d)return;const v=getView(d);
 if(!v.n){ed.style.display='none';return;}
 const s=selOf(d.id),w=widthsOf(d),editing=edit&&edit.g===g&&edit.source==='cell';
 let left=colLeft(d,s.a.c);if(freezeCols&&s.a.c<FREEZE_N)left+=g.scroller.scrollLeft;
 ed.style.display='block';ed.style.left=left+'px';ed.style.top=(g.theadH+s.a.p*g.rowH)+'px';
 ed.style.width=(editing?Math.max(w[s.a.c],150):w[s.a.c])+'px';ed.style.height=g.rowH+'px';
}
function ensureVisible(g,p,c){
 const d=docById(g.id);if(!d)return;const sc=g.scroller,rh=g.rowH,th=g.theadH;
 const top=th+p*rh,bottom=top+rh;
 if(top<sc.scrollTop+th)sc.scrollTop=Math.max(0,top-th);else if(bottom>sc.scrollTop+sc.clientHeight)sc.scrollTop=bottom-sc.clientHeight;
 if(c!==null&&c!==undefined&&!(freezeCols&&c<FREEZE_N)){
  const w=widthsOf(d),left=colLeft(d,c),right=left+w[c],fz=frozenWidth(d);
  if(left<sc.scrollLeft+fz)sc.scrollLeft=Math.max(0,left-fz);else if(right>sc.scrollLeft+sc.clientWidth)sc.scrollLeft=right-sc.clientWidth;
 }
}
function afterSel(d,{ensure=true}={}){
 const g=gridById[d.id];if(!g)return;
 clampSel(d);const s=selOf(d.id);
 if(ensure){ensureVisible(g,s.f.p,s.f.c);}
 const rendered=renderViewport(g);if(!rendered)paintGrid(g);
 placeEditor(g);
 if(!edit&&activeId===d.id)armEditor(g);
 updateBars(d);updateRibbonState();
}
function armEditor(g){if(edit)return;const ed=g.editor;if(ed.value!==' ')ed.value=' ';try{ed.select();}catch(_){}}
function focusGrid(){const g=activeGrid();if(!g||edit)return;armEditor(g);g.editor.focus({preventScroll:true});}

/* ---------- navigation ---------- */
function moveBy(g,dp,dc,{extend=false,wrap=false,edge=false,keepTab=false}={}){
 const d=docById(g.id),v=getView(d);if(!d||!v.n)return;
 const s=selOf(d.id),maxC=d.headers.length-1,base=extend?s.f:s.a;let p=base.p,c=base.c;
 if(!keepTab)g.tabStart=null;
 if(edge){if(dp<0)p=0;else if(dp>0)p=v.n-1;if(dc<0)c=0;else if(dc>0)c=maxC;}
 else{p+=dp;c+=dc;if(wrap){if(c>maxC){c=0;p+=1;}else if(c<0){c=maxC;p-=1;}}}
 p=clamp(p,0,v.n-1);c=clamp(c,0,maxC);
 if(extend)s.f={p,c};else{s.a={p,c};s.f={p,c};s.extra=[];}
 afterSel(d);
}
function moveTo(g,p,c,extend=false){
 const d=docById(g.id),v=getView(d);if(!d||!v.n)return;const s=selOf(d.id);g.tabStart=null;
 p=clamp(p,0,v.n-1);c=clamp(c,0,d.headers.length-1);
 if(extend)s.f={p,c};else{s.a={p,c};s.f={p,c};s.extra=[];}
 afterSel(d);
}
function tabMove(g,dir){const s=selOf(g.id);if(g.tabStart===null)g.tabStart=s.a.c;moveBy(g,0,dir,{wrap:true,keepTab:true});}
function enterMove(g,up){
 const s=selOf(g.id);
 if(!up&&g.tabStart!==null){const col=g.tabStart;g.tabStart=null;const d=docById(g.id),v=getView(d);const p=clamp(s.a.p+1,0,v.n-1);moveTo(g,p,col);return;}
 moveBy(g,up?-1:1,0);
}
function selectAll(g){const d=docById(g.id),v=getView(d);if(!d||!v.n)return;const s=selOf(d.id);s.a={p:0,c:0};s.f={p:v.n-1,c:d.headers.length-1};s.extra=[];afterSel(d,{ensure:false});}
function selectRowOf(g){const d=docById(g.id),s=selOf(d.id);s.a={p:s.a.p,c:0};s.f={p:s.a.p,c:d.headers.length-1};s.extra=[];afterSel(d,{ensure:false});}
function selectColOf(g){const d=docById(g.id),v=getView(d),s=selOf(d.id);s.a={p:0,c:s.a.c};s.f={p:v.n-1,c:s.a.c};s.extra=[];afterSel(d,{ensure:false});}
function gotoRow(docId,row,col=0){
 const d=docById(docId);if(!d)return false;activeId=docId;
 if(!gridById[docId]||!gridById[docId].el.isConnected){splitMode=splitMode&&viewIds.includes(docId);renderAll();}
 const g=gridById[docId],v=getView(d),p=v.posOf(row);
 if(p<0){toast('That row is hidden by the current filter.','error');return false;}
 const s=selOf(docId);s.a={p,c:col};s.f={p,c:col};s.extra=[];afterSel(d);return true;
}

/* ---------- mouse & selection bug fix ---------- */
function hitOf(g,target){
 const t=target&&target.nodeType===1?target:target?.parentElement;if(!t)return null;
 const td=t.closest('td[data-c]');if(td&&g.tbody.contains(td)&&td.parentElement.dataset.p!==undefined)return{kind:'cell',p:+td.parentElement.dataset.p,c:+td.dataset.c};
 const rh=t.closest('th.rh');if(rh&&rh.parentElement.dataset.p!==undefined)return{kind:'row',p:+rh.parentElement.dataset.p};
 const ch=t.closest('th[data-c]');if(ch&&g.thead.contains(ch))return{kind:'col',c:+ch.dataset.c};
 if(t.closest('th.corner'))return{kind:'all'};
 return null;
}
function setActiveDoc(id){
 if(activeId===id)return;
 activeId=id;renderTabs();renderFiles();updateTitle();markActiveCards();updateRibbonState();updateBars(docById(id));
}
function markActiveCards(){for(const g of Object.values(gridById))g.el.classList.toggle('is-active',g.id===activeId);}

function onGridMouseDown(g,e){
if(e.target.closest&&e.target.closest('.grid-add-bar'))return;
 hideContextMenu();
 if(e.button!==0)return;const d=docById(g.id);if(!d)return;
 if(e.target===g.scroller||e.target===g.inner||e.target===g.empty)return;
 const rz=e.target.closest&&e.target.closest('.rz');if(rz){startResize(g,d,+rz.dataset.rz,e);return;}
 const hit=hitOf(g,e.target);if(!hit)return;
 e.preventDefault();
 if(!commitEdit(null,{refocus:false}))return;
 setActiveDoc(d.id);
 const v=getView(d);if(!v.n){return;}
 const s=selOf(d.id),last=d.headers.length-1,maxP=v.n-1,ctrl=e.ctrlKey||e.metaKey;g.tabStart=null;
 if(hit.kind==='cell'){
  if(e.shiftKey)s.f={p:hit.p,c:hit.c};
  else if(ctrl){s.extra.push(rangeOf(s));s.a={p:hit.p,c:hit.c};s.f={p:hit.p,c:hit.c};}
  else{s.a={p:hit.p,c:hit.c};s.f={p:hit.p,c:hit.c};s.extra=[];}
 }else if(hit.kind==='row'){
  if(e.shiftKey){s.a={p:s.a.p,c:0};s.f={p:hit.p,c:last};}
  else{if(ctrl)s.extra.push(rangeOf(s));else s.extra=[];s.a={p:hit.p,c:0};s.f={p:hit.p,c:last};}
 }else if(hit.kind==='col'){
  if(e.shiftKey){s.a={p:0,c:s.a.c};s.f={p:maxP,c:hit.c};}
  else{if(ctrl)s.extra.push(rangeOf(s));else s.extra=[];s.a={p:0,c:hit.c};s.f={p:maxP,c:hit.c};}
 }else{s.a={p:0,c:0};s.f={p:maxP,c:last};s.extra=[];}
 afterSel(d,{ensure:hit.kind==='cell'});
 g.editor.focus({preventScroll:true});
 startDrag(g,d,hit.kind,e);
}

/* Fixed startDrag: initializes coordinates from initial mousedown event and only activates drag/autoscroll after actual pointer movement */
function startDrag(g,d,mode,initEvent){
 const startX=initEvent.clientX,startY=initEvent.clientY;
 let last={x:startX,y:startY},moved=false,timer=null;
 const update=()=>{
  if(!moved)return;
  const rect=g.scroller.getBoundingClientRect(),v=getView(d);if(!v.n)return;
  const x=clamp(last.x,rect.left+ROWNUM_W+2,rect.right-6),y=clamp(last.y,rect.top+g.theadH+2,rect.bottom-6);
  const hit=hitOf(g,document.elementFromPoint(x,y));if(!hit)return;
  const s=selOf(d.id),lastC=d.headers.length-1;
  if(mode==='cell'&&hit.kind==='cell')s.f={p:hit.p,c:hit.c};
  else if(mode==='row'&&hit.p!==undefined){s.a={p:s.a.p,c:0};s.f={p:hit.p,c:lastC};}
  else if(mode==='col'){const cc=hit.kind==='cell'||hit.kind==='col'?hit.c:s.f.c;s.a={p:0,c:s.a.c};s.f={p:v.n-1,c:cc};}
  else return;
  const rendered=renderViewport(g);if(!rendered)paintGrid(g);updateBars(d);
 };
 const tick=()=>{
  if(!moved)return;
  const rect=g.scroller.getBoundingClientRect(),edge=28;let dx=0,dy=0;
  if(mode!=='col'){if(last.y<rect.top+g.theadH+edge)dy=-Math.ceil((rect.top+g.theadH+edge-last.y)/2);else if(last.y>rect.bottom-edge)dy=Math.ceil((last.y-(rect.bottom-edge))/2);}
  if(mode!=='row'){if(last.x<rect.left+ROWNUM_W+edge)dx=-Math.ceil((rect.left+ROWNUM_W+edge-last.x)/2);else if(last.x>rect.right-edge)dx=Math.ceil((last.x-(rect.right-edge))/2);}
  if(dx||dy){g.scroller.scrollTop+=Math.min(60,Math.max(-60,dy));g.scroller.scrollLeft+=Math.min(60,Math.max(-60,dx));update();}
 };
 const move=ev=>{
  last={x:ev.clientX,y:ev.clientY};
  if(!moved&&Math.hypot(last.x-startX,last.y-startY)>4){
   moved=true;
   if(!timer)timer=setInterval(tick,35);
  }
  if(moved)update();
 };
 const up=()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);if(timer)clearInterval(timer);updateRibbonState();};
 window.addEventListener('mousemove',move);window.addEventListener('mouseup',up);
}

function onGridDblClick(g,e){
 const rz=e.target.closest&&e.target.closest('.rz');
 if(rz){const d=docById(g.id);d.colW=autoFitWidths(d,+rz.dataset.rz);saveWidths(d);applyWidths(g,d);return;}
 const hit=hitOf(g,e.target);if(hit&&hit.kind==='cell'){e.preventDefault();beginEdit(g,'edit');}
}
function applyWidths(g,d){g.sig='';buildHead(g,d);renderViewport(g,true);placeEditor(g);}
function startResize(g,d,c,e){
 e.preventDefault();e.stopPropagation();
 const w=widthsOf(d),startX=e.clientX,start=w[c];g.el.classList.add('resizing');
 const move=ev=>{w[c]=Math.max(MIN_COL,Math.round(start+ev.clientX-startX));applyWidths(g,d);};
 const up=()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);g.el.classList.remove('resizing');saveWidths(d);};
 window.addEventListener('mousemove',move);window.addEventListener('mouseup',up);
}

/* ---------- context menu (right-click) ---------- */
function hideContextMenu(){const m=$('#ctxMenu');if(m)m.hidden=true;}
function onGridContextMenu(g,e){
 const d=docById(g.id);if(!d)return;
 const hit=hitOf(g,e.target);if(!hit)return;
 e.preventDefault();
 if(!commitEdit(null,{refocus:false}))return;
 setActiveDoc(d.id);
 const s=selOf(d.id),rg=rangeOf(s);
 if(hit.kind==='cell'){
  if(hit.p<rg.p1||hit.p>rg.p2||hit.c<rg.c1||hit.c>rg.c2){s.a={p:hit.p,c:hit.c};s.f={p:hit.p,c:hit.c};s.extra=[];afterSel(d,{ensure:false});}
 }else if(hit.kind==='row'){
  if(hit.p<rg.p1||hit.p>rg.p2){s.a={p:hit.p,c:0};s.f={p:hit.p,c:d.headers.length-1};s.extra=[];afterSel(d,{ensure:false});}
 }else if(hit.kind==='col'){
  s.a={p:0,c:hit.c};s.f={p:getView(d).n-1,c:hit.c};s.extra=[];afterSel(d,{ensure:false});
 }
 const menu=$('#ctxMenu');
 const rows=selectedModelRows(d).filter(r=>!isMetaRow(r));
 menu.innerHTML=`
  <button type="button" class="ctx-item" data-cmd="row-below"><span>Insert new song row below (auto-TBM)</span><span class="ctx-kbd">Ctrl+Enter</span></button>
  <button type="button" class="ctx-item" data-cmd="row-above"><span>Insert new song row above (auto-TBM)</span></button>
  <button type="button" class="ctx-item" data-cmd="row-dup" ${rows.length?'':'disabled'}><span>Duplicate selected row(s) (+1 TBM)</span><span class="ctx-kbd">Ctrl+Shift+D</span></button>
  <button type="button" class="ctx-item danger" data-cmd="row-del" ${rows.length?'':'disabled'}><span>Delete selected song row(s) (${rows.length})</span></button>
  <div class="ctx-sep"></div>
  <button type="button" class="ctx-item" data-cmd="col-left"><span>Insert column left…</span></button>
  <button type="button" class="ctx-item" data-cmd="col-right"><span>Insert column right…</span></button>
  <button type="button" class="ctx-item danger" data-cmd="col-del" ${d.headers.length>1?'':'disabled'}><span>Delete column “${esc(d.headers[s.a.c]||colName(s.a.c))}”</span></button>
  <div class="ctx-sep"></div>
  <button type="button" class="ctx-item" data-cmd="auto-tbm" ${rows.length?'':'disabled'}><span>Assign next free TBM filename</span></button>
  <button type="button" class="ctx-item" data-cmd="toggle-new" ${rows.length?'':'disabled'}><span>Toggle NEW (0/1)</span></button>
  <button type="button" class="ctx-item" data-cmd="toggle-use" ${rows.length?'':'disabled'}><span>Toggle USE (0/1)</span></button>
  <div class="ctx-sep"></div>
  <button type="button" class="ctx-item" data-cmd="copy"><span>Copy</span><span class="ctx-kbd">Ctrl+C</span></button>
  <button type="button" class="ctx-item" data-cmd="paste"><span>Paste</span><span class="ctx-kbd">Ctrl+V</span></button>
 `;
 menu.hidden=false;
 const mw=menu.offsetWidth||240,mh=menu.offsetHeight||320;
 menu.style.left=Math.min(e.clientX,window.innerWidth-mw-8)+'px';
 menu.style.top=Math.min(e.clientY,window.innerHeight-mh-8)+'px';
 menu.querySelectorAll('[data-cmd]').forEach(btn=>btn.addEventListener('click',()=>{
  const cmd=btn.dataset.cmd;hideContextMenu();
  if(cmd==='row-below')insertRowInTable('below');
  else if(cmd==='row-above')insertRowInTable('above');
  else if(cmd==='row-dup')duplicateSelectedRows();
  else if(cmd==='row-del')deleteSelectedRows();
  else if(cmd==='col-left')openColModal('left');
  else if(cmd==='col-right')openColModal('right');
  else if(cmd==='col-del')deleteActiveColumn();
  else if(cmd==='auto-tbm')assignAutoTbmToSelection();
  else if(cmd==='toggle-new')toggleSelectedField('new');
  else if(cmd==='toggle-use')toggleSelectedField('use');
  else if(cmd==='copy')ribbonCopy(false);
  else if(cmd==='paste')ribbonPaste();
  focusGrid();
 }));
}
window.addEventListener('click',e=>{if(!e.target.closest('#ctxMenu'))hideContextMenu();});

/* ---------- table row & column operations (with auto-TBM & defaults) ---------- */
function insertRowInTable(where='below'){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 const info=activeCellInfo(d);
 const start=songStartIdx(d);
 let refRow=info?info.r:d.records.length-1;
 if(refRow<start)refRow=start-1;
 const fnIdx=findFieldIdx(d,'filename');
 let refPrefix=latestTbmPrefix(d);
 if(fnIdx>=0&&refRow>=start&&d.records[refRow]){
  const parsed=parseTbmName(d.records[refRow][fnIdx]);
  if(parsed)refPrefix=parsed.prefix;
 }
 const tbm=nextTbmFilename(d,refPrefix,0);
 const newRow=newEntrySeed(d,tbm,refRow>=start?refRow:null);
 const insertIdx=where==='above'?Math.max(start,refRow):Math.max(start,refRow+1);
 const history=beginUndo('Insert song row',[d]);
 d.records.splice(insertIdx,0,newRow);
 markDirty(d);
 commitUndo(history);
 if(query){query='';$('#searchInput').value='';}
 viewStamp++;
 renderAll();
 gotoRow(d.id,insertIdx,0);
 toast(`Inserted Row ${insertIdx+1} with TBM ${tbm} (Offset=0.7, NEW=1, USE=1).`);
}

function duplicateSelectedRows(){
 const d=activeDoc();if(!d)return;
 const rows=selectedModelRows(d).filter(r=>!isMetaRow(r));
 if(!rows.length){toast('Select at least one song row (Row 3+) to duplicate.','error');return;}
 const fnIdx=findFieldIdx(d,'filename'),newIdx=findFieldIdx(d,'new'),useIdx=findFieldIdx(d,'use');
 const history=beginUndo('Duplicate row(s)',[d]);
 const clones=rows.map((r,idx)=>{
  const copy=d.records[r].slice();
  if(fnIdx>=0)copy[fnIdx]=incrementTbmFilename(copy[fnIdx],latestTbmPrefix(d),d,idx);
  if(newIdx>=0)copy[newIdx]='1';
  if(useIdx>=0)copy[useIdx]='1';
  return copy;
 });
 const insertAt=rows[rows.length-1]+1;
 d.records.splice(insertAt,0,...clones);
 markDirty(d);
 commitUndo(history);
 viewStamp++;renderAll();
 gotoRow(d.id,insertAt,0);
 toast(`Duplicated ${clones.length} row${clones.length===1?'':'s'} with auto-incremented TBM.`);
}

function deleteSelectedRows(){
 const d=activeDoc();if(!d)return;
 const rows=selectedModelRows(d).filter(r=>!isMetaRow(r));
 if(!rows.length){toast('Row 1 (Headers) and Row 2 (Types) cannot be deleted. Select song rows (Row 3+).','error');return;}
 if(rows.length>5&&!confirm(`Delete ${rows.length} selected rows from ${d.filename}?`))return;
 const history=beginUndo(`Delete ${rows.length} row(s)`,[d]);
 for(let i=rows.length-1;i>=0;i--)d.records.splice(rows[i],1);
 markDirty(d);
 commitUndo(history);
 viewStamp++;renderAll();
 toast(`Deleted ${rows.length} row${rows.length===1?'':'s'}.`);
}

function assignAutoTbmToSelection(){
 const d=activeDoc();if(!d)return;
 const fnIdx=findFieldIdx(d,'filename');
 if(fnIdx<0){toast('No File Name column found in this file.','error');return;}
 const rows=selectedModelRows(d).filter(r=>!isMetaRow(r));
 if(!rows.length){toast('Select song rows (Row 3+) first.','error');return;}
 const prefix=latestTbmPrefix(d)||'g';
 const changes=rows.map((r,i)=>({r,c:fnIdx,v:nextTbmFilename(d,prefix,i)}));
 applyChanges(d,changes,'Auto-generate TBM');
 toast(`Assigned sequential TBM filenames to ${rows.length} row${rows.length===1?'':'s'}.`);
}

function openColModal(pos='right'){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 $('#colPosSelect').value=pos;
 $('#colNameInput').value='';
 $('#colTypeSelect').value='string';
 $('#colDefaultInput').value='';
 $('#colModal').classList.add('visible');
 $('#colNameInput').focus();
}
function closeColModal(){$('#colModal').classList.remove('visible');focusGrid();}
function handleInsertColumn(e){
 e.preventDefault();
 const d=activeDoc();if(!d)return;
 const name=String($('#colNameInput').value||'').trim()||`Column ${d.headers.length+1}`;
 const type=$('#colTypeSelect').value||'string';
 let def=String($('#colDefaultInput').value??'');
 if(def===''&&(type==='int'||type==='float'))def='0';
 const pos=$('#colPosSelect').value;
 const activeCol=selOf(d.id).a.c;
 const insertAt=pos==='left'?activeCol:pos==='right'?activeCol+1:d.headers.length;

 const history=beginUndo(`Insert column ${name}`,[d]);
 d.headers.splice(insertAt,0,name);
 d.types.splice(insertAt,0,type);
 if(d.colW)d.colW.splice(insertAt,0,Math.max(96,Math.round(measureText(name,true)+54)));
 d.records.forEach((row,rIdx)=>{
  while(row.length<insertAt)row.push('');
  row.splice(insertAt,0,rIdx===0?name:rIdx===1?type:def);
 });
 markDirty(d);
 commitUndo(history);
 if(gridById[d.id])gridById[d.id].sig='';
 closeColModal();
 renderAll();
 gotoRow(d.id,selOf(d.id).a.p,insertAt);
 toast(`Inserted column “${name}” (${type}) at column ${colName(insertAt)}.`);
}
function deleteActiveColumn(){
 const d=activeDoc();if(!d)return;
 if(d.headers.length<=1){toast('A file must keep at least one column.','error');return;}
 const c=selOf(d.id).a.c,colTitle=d.headers[c]||colName(c);
 if(!confirm(`Delete column ${colName(c)} (“${colTitle}”) from ${d.filename}? (Can be undone with Ctrl+Z)`))return;
 const history=beginUndo(`Delete column ${colTitle}`,[d]);
 d.headers.splice(c,1);
 d.types.splice(c,1);
 if(d.colW)d.colW.splice(c,1);
 d.records.forEach(row=>row.splice(c,1));
 markDirty(d);
 commitUndo(history);
 if(gridById[d.id])gridById[d.id].sig='';
 renderAll();
 toast(`Deleted column “${colTitle}”.`);
}

/* ---------- Find & Replace Modal (Ctrl+H) ---------- */
function openReplaceModal(){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 const sel=$('#replaceScopeSelect');
 const curCol=selOf(d.id).a.c;
 sel.innerHTML=`<option value="all">All columns</option>`+d.headers.map((h,i)=>`<option value="${i}" ${i===curCol?'selected':''}>Column ${colName(i)}: ${esc(h)}</option>`).join('');
 $('#replaceModal').classList.add('visible');
 $('#findTextInput').focus();$('#findTextInput').select();
}
function closeReplaceModal(){$('#replaceModal').classList.remove('visible');focusGrid();}
function handleReplaceAll(e){
 e.preventDefault();
 const d=activeDoc();if(!d)return;
 const needle=$('#findTextInput').value;
 if(!needle){toast('Enter text to find.','error');return;}
 const repl=$('#replaceTextInput').value??'';
 const scope=$('#replaceScopeSelect').value;
 const matchCase=$('#replaceCaseCheck').checked;
 const cols=scope==='all'?d.headers.map((_,i)=>i):[Number(scope)];
 const changes=[];
 const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const rx=new RegExp(escaped,matchCase?'g':'gi');

 for(let r=songStartIdx(d);r<d.records.length;r++){
  for(const c of cols){
   const cur=String(d.records[r][c]??'');
   if(!rx.test(cur))continue;
   const next=cur.replace(rx,repl);
   const norm=normalizeCellInput(d,c,next);
   if(norm.ok&&norm.v!==cur)changes.push({r,c,v:norm.v});
  }
 }
 if(!changes.length){toast('No matching cells found (or replacement is invalid for column type).','error');return;}
 const count=applyChanges(d,changes,'Find & Replace');
 closeReplaceModal();
 toast(`Replaced in ${fmtInt(count)} cell${count===1?'':'s'}.`);
}

/* ---------- Duplicate & TBM Health Check ---------- */
function openIssuesModal(){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 const fnIdx=findFieldIdx(d,'filename'),singerIdx=findFieldIdx(d,'singer'),titleIdx=findFieldIdx(d,'title');
 const seenTbm=new Map(),seenTrack=new Map(),issues=[];
 for(let r=songStartIdx(d);r<d.records.length;r++){
  const row=d.records[r];
  const fn=fnIdx>=0?String(row[fnIdx]??'').trim():'';
  const singer=singerIdx>=0?String(row[singerIdx]??'').trim():'';
  const title=titleIdx>=0?String(row[titleIdx]??'').trim():'';
  if(fnIdx>=0&&!fn){
   issues.push({r,c:fnIdx,badge:'Missing TBM',text:`Row ${r+1}: Empty file name (${singer||'No Artist'} — ${title||'No Title'})`});
  }else if(fn&&/\.tbm$/i.test(fn)){
   const key=fn.toLowerCase();
   if(seenTbm.has(key)){
    issues.push({r,c:fnIdx,badge:'Duplicate TBM',text:`Row ${r+1}: “${fn}” is already used in Row ${seenTbm.get(key)+1}`});
   }else seenTbm.set(key,r);
  }
  if(singer&&title){
   const tKey=`${singer.toLowerCase()}\u001f${title.toLowerCase()}`;
   if(seenTrack.has(tKey)){
    issues.push({r,c:titleIdx>=0?titleIdx:0,badge:'Duplicate Song',text:`Row ${r+1}: “${singer} - ${title}” also appears in Row ${seenTrack.get(tKey)+1}`});
   }else seenTrack.set(tKey,r);
  }
 }
 $('#issuesModalSub').textContent=issues.length?`Found ${issues.length} potential issue${issues.length===1?'':'s'} in ${d.filename}:`:`No duplicate TBM codes or missing filenames found in ${d.filename}!`;
 const list=$('#issuesList');
 if(!issues.length){
  list.innerHTML=`<div class="issue-item"><span>✓ All TBM filenames and song entries look clean!</span></div>`;
 }else{
  list.innerHTML=issues.slice(0,200).map(it=>`<div class="issue-item"><div><span class="issue-badge">${esc(it.badge)}</span> <span style="margin-left:6px">${esc(it.text)}</span></div><button type="button" class="btn btn-sm" data-jump-r="${it.r}" data-jump-c="${it.c}">Jump to Row ${it.r+1}</button></div>`).join('');
  list.querySelectorAll('[data-jump-r]').forEach(btn=>btn.addEventListener('click',()=>{
   $('#issuesModal').classList.remove('visible');
   gotoRow(d.id,Number(btn.dataset.jumpR),Number(btn.dataset.jumpC));
   focusGrid();
  }));
 }
 $('#issuesModal').classList.add('visible');
}

/* ---------- data changes (one undo step per action) ---------- */
function applyChanges(d,changes,label){
 const byRow=new Map();
 for(const ch of changes){
  const row=d.records[ch.r];if(!row)continue;if(String(row[ch.c]??'')===String(ch.v))continue;
  if(!byRow.has(ch.r))byRow.set(ch.r,{before:row.slice(),list:[]});byRow.get(ch.r).list.push(ch);
 }
 if(!byRow.size)return 0;
 const history=beginUndo(label,[d]);
 let n=0,metaTouched=false;
 for(const [r,o] of byRow){
  const row=d.records[r];
  if(isMetaRow(r))metaTouched=true;
  for(const ch of o.list){row[ch.c]=String(ch.v);n++;}
 }
 markDirty(d);
 commitUndo(history);
 if(metaTouched&&gridById[d.id]){gridById[d.id].sig='';buildHead(gridById[d.id],d);}
 const ident=['singer','title','filename'].map(f=>findFieldIdx(d,f));
 const touchesIdent=changes.some(ch=>ident.includes(ch.c));
 refreshAfterData(d,changes,touchesIdent||metaTouched);
 return n;
}
function refreshAfterData(d,changes,touchesIdent){
 const g=gridById[d.id],useIdx=findFieldIdx(d,'use');
 if(g&&g.el.isConnected){
  if(changes.length>40||changes.some(ch=>ch.c===useIdx||isMetaRow(ch.r)))renderViewport(g,true);
  else for(const ch of changes){const td=g.tbody.querySelector(`tr[data-r="${ch.r}"] td[data-c="${ch.c}"]`);if(td)td.textContent=d.records[ch.r][ch.c]??'';}
 }
 renderTabs();renderFiles();updateTitle();updateStatusRight();
 if(touchesIdent)renderCoverage();
 updateBars(d);updateRibbonState();
}
function normalizeCellInput(d,c,raw,rowIdx=2){
 const v=String(raw??'');
 if(rowIdx===0)return{ok:true,v:v.trim()||`Column ${c+1}`};
 if(rowIdx===1){
  const t=normalize(v);
  if(t!=='string'&&t!=='int'&&t!=='float')return{ok:false,msg:'Row 2 defines column types: use string, int, or float.'};
  return{ok:true,v:t};
 }
 const t=typeOf(d,c);
 if(t==='int'||t==='float'){
  const s=v.trim().replace(/,/g,'.');if(s==='')return{ok:true,v:'0'};
  const num=Number(s),name=d.headers[c]||`Column ${c+1}`;
  if(!Number.isFinite(num))return{ok:false,msg:`“${v.trim()}” is not a valid number for ${name}.`};
  if(t==='int'&&!Number.isInteger(num))return{ok:false,msg:`${name} expects a whole number.`};
  return{ok:true,v:s};
 }
 return{ok:true,v};
}
function clearSelection(g){
 const d=docById(g.id);if(!d)return;const v=getView(d),s=selOf(d.id),changes=[],seen=new Set();
 for(const rg of allRanges(s))for(let p=rg.p1;p<=rg.p2&&p<v.n;p++)for(let c=rg.c1;c<=rg.c2;c++){
  const r=v.at(p);if(isMetaRow(r))continue;
  const k=r*4096+c;if(seen.has(k))continue;seen.add(k);changes.push({r,c,v:isNumericCol(d,c)?'0':''});
 }
 const n=applyChanges(d,changes,'Clear cells');flashStatus(n?`Cleared ${fmtInt(n)} cell${n===1?'':'s'}.`:'Nothing to clear.');
}
function fillSelection(g,dir){
 const d=docById(g.id);if(!d)return;const v=getView(d),s=selOf(d.id),rg=rangeOf(s),changes=[];
 if(dir==='down'){
  if(rg.p1===rg.p2){if(rg.p1===0){flashStatus('Nothing above to fill from.');return;}
   for(let c=rg.c1;c<=rg.c2;c++)changes.push({r:v.at(rg.p1),c,v:d.records[v.at(rg.p1-1)][c]});}
  else for(let c=rg.c1;c<=rg.c2;c++){const src=d.records[v.at(rg.p1)][c];for(let p=rg.p1+1;p<=rg.p2;p++)changes.push({r:v.at(p),c,v:src});}
 }else{
  if(rg.c1===rg.c2){if(rg.c1===0){flashStatus('Nothing to the left to fill from.');return;}
   for(let p=rg.p1;p<=rg.p2;p++){const r=v.at(p);changes.push({r,c:rg.c1,v:d.records[r][rg.c1-1]});}}
  else for(let p=rg.p1;p<=rg.p2;p++){const r=v.at(p),src=d.records[r][rg.c1];for(let c=rg.c1+1;c<=rg.c2;c++)changes.push({r,c,v:src});}
 }
 const validChanges=changes.filter(ch=>!isMetaRow(ch.r));
 const bad=validChanges.find(ch=>!normalizeCellInput(d,ch.c,ch.v,ch.r).ok);
 if(bad){toast('Fill skipped: the source value is not valid for the target column type.','error');return;}
 const n=applyChanges(d,validChanges,dir==='down'?'Fill down':'Fill right');flashStatus(n?`Filled ${fmtInt(n)} cell${n===1?'':'s'}.`:'Cells already contain the same values.');
}
function toggleSelectedField(field){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 const idx=findFieldIdx(d,field);if(idx<0){toast(`${field.toUpperCase()} is not available in this file.`,'error');return;}
 const rows=selectedModelRows(d).filter(r=>!isMetaRow(r));if(!rows.length){toast('Select one or more song rows (Row 3+) first.','error');return;}
 const changes=rows.map(r=>({r,c:idx,v:String(d.records[r][idx]??'').trim()==='1'?'0':'1'}));
 applyChanges(d,changes,`Toggle ${field.toUpperCase()}`);
 toast(`${field.toUpperCase()} toggled for ${rows.length} row${rows.length===1?'':'s'}.`);
}

/* ---------- clipboard ---------- */
function tsvQuote(s){return /[\t\n\r"]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function rangeToTSV(d,v,rg){
 const lines=[];
 for(let p=rg.p1;p<=rg.p2&&p<v.n;p++){const row=d.records[v.at(p)],cells=[];for(let c=rg.c1;c<=rg.c2;c++)cells.push(tsvQuote(String(row[c]??'')));lines.push(cells.join('\t'));}
 return lines.join('\n');
}
function parseTSV(text){
 const rows=[];let row=[],cur='',q=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(q){if(ch==='"'){if(text[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=ch;}
  else if(ch==='"'&&cur===''){q=true;}
  else if(ch==='\t'){row.push(cur);cur='';}
  else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cur);rows.push(row);row=[];cur='';}
  else cur+=ch;
 }
 if(cur!==''||row.length||!rows.length){row.push(cur);rows.push(row);}
 return rows;
}
function copyText(g){
 const d=docById(g.id),v=getView(d);if(!d||!v.n)return null;
 const s=selOf(d.id),rg=rangeOf(s);
 if(s.extra.length)flashStatus('Several ranges are selected — only the last one is copied.');
 return {text:rangeToTSV(d,v,rg),rows:rg.p2-rg.p1+1,cols:rg.c2-rg.c1+1};
}
function pasteText(g,text){
 const d=docById(g.id),v=getView(d);if(!d||!v.n)return;
 const rows=parseTSV(String(text??'')),s=selOf(d.id),rg=rangeOf(s),maxC=d.headers.length-1;
 const single=rows.length===1&&rows[0].length===1,changes=[];let skipped=0,clipped=false;
 if(single&&(rg.p2>rg.p1||rg.c2>rg.c1||s.extra.length)){
  const seen=new Set();
  for(const r of allRanges(s))for(let p=r.p1;p<=r.p2&&p<v.n;p++)for(let c=r.c1;c<=r.c2;c++){
   const row=v.at(p),k=row*4096+c;if(seen.has(k))continue;seen.add(k);
   const res=normalizeCellInput(d,c,rows[0][0],row);if(!res.ok){skipped++;continue;}changes.push({r:row,c,v:res.v});}
 }else{
  for(let i=0;i<rows.length;i++)for(let j=0;j<rows[i].length;j++){
   const p=rg.p1+i,c=rg.c1+j;if(p>=v.n||c>maxC){clipped=true;continue;}
   const row=v.at(p);
   const res=normalizeCellInput(d,c,rows[i][j],row);if(!res.ok){skipped++;continue;}changes.push({r:row,c,v:res.v});}
  const width=Math.max(...rows.map(r=>r.length));
  s.a={p:rg.p1,c:rg.c1};s.f={p:Math.min(v.n-1,rg.p1+rows.length-1),c:Math.min(maxC,rg.c1+width-1)};s.extra=[];
 }
 const n=applyChanges(d,changes,'Paste');
 afterSel(d,{ensure:false});
 flashStatus(n?`Pasted ${fmtInt(n)} cell${n===1?'':'s'}.`:'Pasted values were identical — nothing changed.');
 if(skipped)toast(`${skipped} value${skipped===1?'':'s'} skipped: not valid for the column type.`,'error');
 if(clipped)toast('Some pasted cells fell outside the table and were ignored.');
}
function anyModalOpen(){
 return $('#entryModal').classList.contains('visible')||$('#helpModal').classList.contains('visible')||$('#colModal').classList.contains('visible')||$('#replaceModal').classList.contains('visible')||$('#issuesModal').classList.contains('visible')||!$('#themeModal').hidden;
}
function clipboardAllowed(e){
 if(edit||anyModalOpen())return false;
 const t=e.target;if(t&&t.matches&&t.matches('input,textarea,select')&&!t.classList.contains('cell-editor'))return false;
 return !!activeGrid();
}
document.addEventListener('copy',e=>{
 if(!clipboardAllowed(e))return;const info=copyText(activeGrid());if(!info)return;
 e.clipboardData.setData('text/plain',info.text);e.preventDefault();flashStatus(`Copied ${info.rows} × ${info.cols} cell${info.rows*info.cols===1?'':'s'}.`);
});
document.addEventListener('cut',e=>{
 if(!clipboardAllowed(e))return;const g=activeGrid(),info=copyText(g);if(!info)return;
 e.clipboardData.setData('text/plain',info.text);e.preventDefault();clearSelection(g);
});
document.addEventListener('paste',e=>{
 if(!clipboardAllowed(e))return;e.preventDefault();pasteText(activeGrid(),e.clipboardData.getData('text/plain'));
});
async function ribbonCopy(cut){
 const g=activeGrid();if(!g)return;const info=copyText(g);if(!info)return;
 try{await navigator.clipboard.writeText(info.text);flashStatus(`${cut?'Cut':'Copied'} ${info.rows} × ${info.cols} cell${info.rows*info.cols===1?'':'s'}.`);if(cut)clearSelection(g);}
 catch(_){toast('The browser blocked clipboard access — use Ctrl+C / Ctrl+X instead.','error');}
}
async function ribbonPaste(){
 const g=activeGrid();if(!g)return;
 try{pasteText(g,await navigator.clipboard.readText());}
 catch(_){toast('The browser blocked clipboard access — use Ctrl+V instead.','error');}
}

/* ---------- cell editing ---------- */
function beginEdit(g,mode,opts={}){
 const d=docById(g.id);if(!d)return false;const v=getView(d);if(!v.n)return false;
 if(edit&&!commitEdit(null,{refocus:false}))return false;
 const s=selOf(d.id),p=s.a.p,c=s.a.c,r=v.at(p);
 ensureVisible(g,p,c);renderViewport(g);
 edit={g,id:d.id,p,r,c,orig:String(d.records[r]?.[c]??''),mode,source:'cell'};
 g.editor.classList.add('on');placeEditor(g);
 g.editor.value=opts.value!==undefined?opts.value:edit.orig;
 g.editor.focus({preventScroll:true});
 const L=g.editor.value.length;try{g.editor.setSelectionRange(L,L);}catch(_){}
 $('#formulaInput').value=g.editor.value;
 updateStatus(mode==='enter'?'Enter — arrow keys commit and move':'Edit — arrow keys move the caret · F2 switches mode');
 return true;
}
function finishEditUi(g){
 g.editor.classList.remove('on');g.editor.value='';placeEditor(g);
}
function commitEdit(move,opts={}){
 if(!edit)return true;
 const e=edit,d=docById(e.id),g=e.g;
 if(!d){edit=null;return true;}
 const raw=e.source==='bar'?$('#formulaInput').value:g.editor.value;
 const res=normalizeCellInput(d,e.c,raw,e.r);
 if(!res.ok){toast(res.msg,'error');g.editor.classList.add('bad');setTimeout(()=>g.editor.classList.remove('bad'),500);(e.source==='bar'?$('#formulaInput'):g.editor).focus({preventScroll:true});return false;}
 edit=null;finishEditUi(g);updateStatus('Ready');
 if(res.v!==e.orig)applyChanges(d,[{r:e.r,c:e.c,v:res.v}],'Edit cell');
 if(opts.refocus!==false){armEditor(g);g.editor.focus({preventScroll:true});}
 updateBars(d);
 return true;
}
function cancelEdit(){
 if(!edit)return;const e=edit,g=e.g,d=docById(e.id);edit=null;finishEditUi(g);updateStatus('Ready');
 armEditor(g);g.editor.focus({preventScroll:true});if(d)updateBars(d);
}
function onEditorInput(g){
 if(!edit){beginEdit(g,'enter',{value:g.editor.value});return;}
 if(edit.g===g&&edit.source==='cell')$('#formulaInput').value=g.editor.value;
}
function onEditorKeydown(g,e){
 if(e.isComposing||e.key==='Process'||e.keyCode===229)return;
 if(edit&&edit.g===g&&edit.source==='cell')return editingKey(g,e);
 gridKey(g,e);
}
function editingKey(g,e){
 const k=e.key,shift=e.shiftKey;
 if(k==='Enter'){e.preventDefault();if(commitEdit())enterMove(g,shift);return;}
 if(k==='Tab'){e.preventDefault();if(commitEdit())tabMove(g,shift?-1:1);return;}
 if(k==='Escape'){e.preventDefault();cancelEdit();return;}
 if(k==='ArrowDown'||k==='ArrowUp'){e.preventDefault();if(commitEdit())moveBy(g,k==='ArrowDown'?1:-1,0);return;}
 if((k==='ArrowLeft'||k==='ArrowRight')&&edit.mode==='enter'){e.preventDefault();if(commitEdit())moveBy(g,0,k==='ArrowRight'?1:-1);return;}
 if(k==='F2'){e.preventDefault();edit.mode=edit.mode==='enter'?'edit':'enter';updateStatus(edit.mode==='enter'?'Enter — arrow keys commit and move':'Edit — arrow keys move the caret · F2 switches mode');return;}
}
function gridKey(g,e){
 const d=docById(g.id);if(!d)return;
 const v=getView(d),k=e.key,ctrl=e.ctrlKey||e.metaKey,shift=e.shiftKey,alt=e.altKey,lk=k.length===1?k.toLowerCase():k;
 if(k==='F1'){e.preventDefault();openHelp();return;}
 if(ctrl&&!alt){
  if(k==='Enter'){e.preventDefault();insertRowInTable('below');return;}
  if(lk==='z'){e.preventDefault();shift?redoEdit():undoEdit();return;}
  if(lk==='y'){e.preventDefault();redoEdit();return;}
  if(lk==='f'){e.preventDefault();const si=$('#searchInput');si.focus();si.select();return;}
  if(lk==='h'){e.preventDefault();openReplaceModal();return;}
  if(lk==='a'){e.preventDefault();selectAll(g);return;}
  if(lk==='d'){e.preventDefault();if(shift)duplicateSelectedRows();else fillSelection(g,'down');return;}
  if(lk==='r'){e.preventDefault();fillSelection(g,'right');return;}
  if(lk===' '){e.preventDefault();selectColOf(g);return;}
  if(!v.n)return;
  if(k==='ArrowUp'||k==='ArrowDown'||k==='ArrowLeft'||k==='ArrowRight'){e.preventDefault();moveBy(g,k==='ArrowUp'?-1:k==='ArrowDown'?1:0,k==='ArrowLeft'?-1:k==='ArrowRight'?1:0,{extend:shift,edge:true});return;}
  if(k==='Home'){e.preventDefault();moveTo(g,0,0,shift);return;}
  if(k==='End'){e.preventDefault();moveTo(g,v.n-1,d.headers.length-1,shift);return;}
  return;
 }
 if(!v.n)return;
 const page=Math.max(1,Math.floor((g.scroller.clientHeight-g.theadH)/g.rowH)-1);
 switch(k){
  case 'ArrowUp':e.preventDefault();moveBy(g,-1,0,{extend:shift});return;
  case 'ArrowDown':e.preventDefault();moveBy(g,1,0,{extend:shift});return;
  case 'ArrowLeft':e.preventDefault();moveBy(g,0,-1,{extend:shift});return;
  case 'ArrowRight':e.preventDefault();moveBy(g,0,1,{extend:shift});return;
  case 'Tab':e.preventDefault();tabMove(g,shift?-1:1);return;
  case 'Enter':e.preventDefault();if(enterEdits&&!shift)beginEdit(g,'edit');else enterMove(g,shift);return;
  case 'F2':e.preventDefault();beginEdit(g,'edit');return;
  case 'Home':e.preventDefault();moveTo(g,selOf(d.id).f.p,0,shift);return;
  case 'End':e.preventDefault();moveTo(g,selOf(d.id).f.p,d.headers.length-1,shift);return;
  case 'PageUp':e.preventDefault();moveBy(g,-page,0,{extend:shift});return;
  case 'PageDown':e.preventDefault();moveBy(g,page,0,{extend:shift});return;
  case 'Delete':e.preventDefault();clearSelection(g);return;
  case 'Backspace':e.preventDefault();beginEdit(g,'enter',{value:''});return;
  case 'Escape':{const s=selOf(d.id);if(s.extra.length||s.a.p!==s.f.p||s.a.c!==s.f.c){e.preventDefault();s.f={...s.a};s.extra=[];afterSel(d,{ensure:false});}return;}
  case ' ':if(shift){e.preventDefault();selectRowOf(g);}return;
 }
}

/* ---------- name box + formula bar (1:1 SLK coordinates: A1 = Row 1) ---------- */
function parseRef(text){
 const m=String(text||'').match(/^\s*([A-Za-z]{1,3})(\d+)\s*(?::\s*([A-Za-z]{1,3})(\d+))?\s*$/);if(!m)return null;
 const a={c:colIndexFromName(m[1]),row:Number(m[2])-1};
 const b=m[3]?{c:colIndexFromName(m[3]),row:Number(m[4])-1}:a;return{a,b};
}
function jumpToRef(text){
 const d=activeDoc(),g=activeGrid();if(!d||!g)return false;
 const ref=parseRef(text);if(!ref){toast('Enter a cell like C12 or a range like A1:D9.','error');return false;}
 const v=getView(d),maxC=d.headers.length-1;
 const ok=x=>x.row>=0&&x.row<d.records.length&&x.c>=0&&x.c<=maxC;
 if(!ok(ref.a)||!ok(ref.b)){toast(`That reference is outside this file (rows 1–${d.records.length}, columns A–${colName(maxC)}).`,'error');return false;}
 const pa=v.posOf(ref.a.row),pb=v.posOf(ref.b.row);if(pa<0||pb<0){toast('That row is hidden by the current filter.','error');return false;}
 const s=selOf(d.id);g.tabStart=null;s.a={p:pa,c:ref.a.c};s.f={p:pb,c:ref.b.c};s.extra=[];afterSel(d);return true;
}
function updateBars(d){
 d=d||activeDoc();
 const nb=$('#nameBox'),fi=$('#formulaInput'),fc=$('#fbCol');
 if(!d||!d.records.length||!getView(d).n){nb.value='';fc.textContent='';if(document.activeElement!==fi&&!edit)fi.value='';$('#selInfo').textContent=d&&d.records.length?'No rows match the filter':'';return;}
 const v=getView(d),s=selOf(d.id),info=activeCellInfo(d),rg=rangeOf(s),multi=rg.p1!==rg.p2||rg.c1!==rg.c2;
 if(document.activeElement!==nb)nb.value=multi?`${colName(rg.c1)}${v.at(rg.p1)+1}:${colName(rg.c2)}${v.at(rg.p2)+1}`:`${colName(info.c)}${info.r+1}`;
 const rowTag=info.r===0?' (Row 1 · Header)':info.r===1?' (Row 2 · Type)':'';
 fc.textContent=`${d.headers[info.c]||colName(info.c)} · ${typeTag(d,info.c)}${rowTag}`;
 if(!edit&&document.activeElement!==fi)fi.value=info.value;
 $('#selInfo').textContent=selectionSummary(d,v,s,info);
}
function selectionSummary(d,v,s,info){
 const ranges=allRanges(s);let count=0,numCount=0,sum=0,min=Infinity,max=-Infinity,nonEmpty=0;const seen=new Set();
 for(const rg of ranges)for(let p=rg.p1;p<=rg.p2&&p<v.n;p++){const row=d.records[v.at(p)];for(let c=rg.c1;c<=rg.c2;c++){
  const k=p*4096+c;if(seen.has(k))continue;seen.add(k);count++;const val=String(row[c]??'').trim();
  if(val!==''){nonEmpty++;const num=Number(val.replace(',','.'));if(Number.isFinite(num)){numCount++;sum+=num;min=Math.min(min,num);max=Math.max(max,num);}}}}
 const pos=`Row ${info.r+1} · Col ${colName(info.c)}`;
 if(count<=1)return pos;
 let out=`${pos} · ${fmtInt(count)} cells selected`;
 if(numCount>=2&&numCount===nonEmpty){const f=x=>Number(x.toPrecision(10)).toLocaleString('en-US',{maximumFractionDigits:6});out+=` · Sum ${f(sum)} · Avg ${f(sum/numCount)} · Min ${f(min)} · Max ${f(max)}`;}
 return out;
}
(function bindBars(){
 const nb=$('#nameBox'),fi=$('#formulaInput');
 nb.addEventListener('focus',()=>nb.select());
 nb.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();if(jumpToRef(nb.value)){nb.blur();focusGrid();}}
  else if(e.key==='Escape'){e.preventDefault();nb.blur();updateBars();focusGrid();}
 });
 nb.addEventListener('blur',()=>updateBars());
 fi.addEventListener('focus',()=>{
  const d=activeDoc(),g=activeGrid();if(!d||!g||!getView(d).n)return;
  if(edit&&edit.source==='cell'){edit.source='bar';fi.value=g.editor.value;g.editor.classList.remove('on');placeEditor(g);return;}
  if(!edit){const info=activeCellInfo(d);edit={g,id:d.id,p:info.p,r:info.r,c:info.c,orig:info.value,mode:'edit',source:'bar'};}
 });
 fi.addEventListener('input',()=>{if(edit&&edit.source==='cell')edit.g.editor.value=fi.value;});
 fi.addEventListener('keydown',e=>{
  if(!edit||edit.source!=='bar')return;const g=edit.g;
  if(e.key==='Enter'){e.preventDefault();if(commitEdit(null,{refocus:false})){focusGrid();enterMove(g,e.shiftKey);}}
  else if(e.key==='Tab'){e.preventDefault();if(commitEdit(null,{refocus:false})){focusGrid();tabMove(g,e.shiftKey?-1:1);}}
  else if(e.key==='Escape'){e.preventDefault();const d=docById(edit.id);edit=null;if(d)updateBars(d);focusGrid();}
 });
 fi.addEventListener('blur',()=>setTimeout(()=>{if(edit&&edit.source==='bar'&&document.activeElement!==fi)commitEdit(null,{refocus:false});},0));
})();

/* ---------- panels: files, tabs, title, status, ribbon ---------- */
function renderFiles(){
 const strip=$('#fileList');if(!strip)return;
 if(!docs.length){strip.innerHTML='<div class="strip-empty">No files loaded yet — import .slk files on the Home tab.</div>';return;}
 strip.innerHTML=docs.map(d=>{
  const root=d.id===rootId,kind=kindOf(d),hasLevel=findFieldIdx(d,'level')>=0;
  return `<div class="fcard${d.id===activeId?' active':''}${root?' is-root':''}">
   <div class="fcard-top"><button type="button" class="fc-root${root?' on':''}" data-root="${d.id}" title="Make this file the single Root"><span class="root-box">✓</span>Root</button><button type="button" class="fc-name" data-open="${d.id}" title="Open ${esc(d.filename)}">${esc(baseNoExt(d.exportName||d.filename))}</button><button type="button" class="fc-x" data-remove="${d.id}" title="Remove from workspace only">×</button></div>
   <div class="fcard-mid"><span>${esc(labelForKind(kind))}</span><span>${fmtInt(d.records.length)} rows · ${d.headers.length} cols</span></div>
   <div class="fcard-bot"><label class="target-check" title="Receive the active Root row when it is applied to targets"><input type="checkbox" data-target="${d.id}" ${d.syncTarget?'checked':''} ${root?'disabled':''}><span>Target</span></label>${root?'<span class="file-tag">ROOT SOURCE</span>':`<label class="level-editor">Level <input type="number" min="0" step="1" data-level="${d.id}" value="${esc(d.targetLevel??'3')}" ${hasLevel?'':'disabled title="This file has no Level column"'}></label>`}</div>
  </div>`;
 }).join('');
 $$('#fileList [data-open]').forEach(b=>b.addEventListener('click',()=>{activeId=b.dataset.open;renderAll();focusGrid();}));
 $$('#fileList [data-root]').forEach(b=>b.addEventListener('click',()=>setRoot(b.dataset.root)));
 $$('#fileList [data-target]').forEach(el=>el.addEventListener('change',()=>{const d=docById(el.dataset.target);if(d){d.syncTarget=el.checked;updateRibbonState();renderFiles();}}));
 $$('#fileList [data-level]').forEach(el=>el.addEventListener('change',()=>{const d=docById(el.dataset.level);if(d){d.targetLevel=String(Math.max(0,Number(el.value)||0));el.value=d.targetLevel;}}));
 $$('#fileList [data-remove]').forEach(b=>b.addEventListener('click',()=>removeDoc(b.dataset.remove)));
}
function removeDoc(id){
 const d=docById(id);if(!d)return;
 if(!confirm(`Remove ${d.filename} from this workspace? The original file on disk will not be changed.`))return;
 docs=docs.filter(x=>x.id!==id);dirty.delete(id);delete selById[id];viewCache.delete(id);
 if(edit&&edit.id===id)edit=null;
 if(gridById[id]){gridById[id].el.remove();delete gridById[id];}
 viewIds=viewIds.filter(x=>x!==id);
 if(activeId===id)activeId=docs[0]?.id||null;
 if(rootId===id){const next=docs.find(x=>kindOf(x)==='root')||[...docs].sort((a,b)=>b.records.length-a.records.length)[0];rootId=next?.id||null;syncFieldKeys.clear();docs.forEach(x=>{x.syncTarget=x.id!==rootId;});}
 if(rootId){const root=docById(rootId);if(root)root.syncTarget=false;}
 if(!viewIds.length&&docs.length)viewIds=docs.slice(0,Math.min(3,docs.length)).map(x=>x.id);
 syncFieldKeys=defaultSyncFieldKeys();undoStack=[];redoStack=[];
 renderAll();toast(`${d.filename} removed from workspace.`);
}
function renderTabs(){
 $('#tabs').innerHTML=docs.map(d=>`<button type="button" class="tab${d.id===activeId?' active':''}" data-tab="${d.id}" title="${esc(d.filename)}">${d.id===rootId?'<span class="tab-root" title="Root"></span>':''}<span class="tab-name">${esc(baseNoExt(d.exportName||d.filename))}</span>${dirty.has(d.id)?'<span class="dirty-dot" aria-label="Unsaved changes">•</span>':''}</button>`).join('');
 $$('#tabs [data-tab]').forEach(b=>b.addEventListener('click',()=>{
  if(!commitEdit(null,{refocus:false}))return;
  const id=b.dataset.tab;
  if(splitMode&&viewIds.includes(id)){setActiveDoc(id);}else{activeId=id;renderAll();}
  focusGrid();
 }));
}
function updateTitle(){
 const d=activeDoc();
 $('#docTitleName').textContent=d?`${baseNoExt(d.exportName||d.filename)} · ${labelForKind(kindOf(d))}${isRoot(d)?' (Root)':''}`:'No file loaded';
 $('#docTitleDirty').hidden=!(d&&dirty.has(d.id));
 document.title=d?`${baseNoExt(d.exportName||d.filename)}${dirty.has(d.id)?' •':''} — Pochita SLK Editor`:'Pochita SLK Editor v1.4.1';
}
function updateStatusRight(){
 const d=activeDoc();
 $('#statusRight').textContent=d?`${fmtInt(d.records.length)} total rows (${fmtInt(Math.max(0,d.records.length-2))} songs) · ${d.headers.length} cols · ${d.encoding}${dirty.size?` · ${dirty.size} file${dirty.size===1?'':'s'} changed`:''}`:'Import SLK files to start editing. Files stay in this browser session until exported.';
}
let statusTimer=null;
function flashStatus(text){updateStatus(text);clearTimeout(statusTimer);statusTimer=setTimeout(()=>{if(!edit)updateStatus('Ready');},3200);}
function setDisabled(id,flag){const el=$('#'+id);if(el)el.disabled=!!flag;}
function updateRibbonState(){
 const d=activeDoc(),hasRows=!!d&&getView(d).n>0;
 setDisabled('undoBtn',!undoStack.length);setDisabled('redoBtn',!redoStack.length);
 $('#undoBtn').title=undoStack.length?`Undo: ${undoStack[undoStack.length-1].label} (Ctrl+Z)`:'Nothing to undo';
 $('#redoBtn').title=redoStack.length?`Redo: ${redoStack[redoStack.length-1].label} (Ctrl+Y)`:'Nothing to redo';
 for(const id of ['cutBtn','copyBtn','pasteBtn','clearBtn','fillDownBtn','fillRightBtn','insertRowBelowBtn','insertRowAboveBtn','dupRowBtn','deleteRowBtn','insertColRightBtn','insertColLeftBtn','deleteColBtn','autoTbmBtn','checkIssuesBtn','replaceModalBtn'])setDisabled(id,!hasRows);
 setDisabled('toggleSelectedNewBtn',!hasRows||findFieldIdx(d,'new')<0);
 setDisabled('toggleSelectedUseBtn',!hasRows||findFieldIdx(d,'use')<0);
 setDisabled('resetNewFlagsBtn',!docs.some(file=>findFieldIdx(file,'new')>=0&&file.records.slice(songStartIdx(file)).some(row=>getVal(file,row,'new').trim()==='1')));
 setDisabled('newEntryBtn',!(docById(rootId)||d));
 setDisabled('syncBtn',!docById(rootId)||!targetDocs().length||syncFieldKeys.size===0);
 setDisabled('exportCurrentBtn',!d);setDisabled('exportZipBtn',!docs.length);setDisabled('resetDemoBtn',!docs.length);setDisabled('autoFitBtn',!d);
 $('#resultCount').textContent=d?(query?`${fmtInt(getView(d).n)} of ${fmtInt(d.records.length)} rows`:`${fmtInt(d.records.length)} rows`):'—';
}
function renderCoverage(){
 const box=$('#coverageBox');if(!box)return;const root=docById(rootId);
 if(!root||findFieldIdx(root,'filename')<0){box.innerHTML='';return;}
 const rootNamesByTrack=new Map();
 for(let r=songStartIdx(root);r<root.records.length;r++){
  const row=root.records[r],key=trackIdentity(root,row);if(key==='\u001f')continue;
  const name=normalize(getVal(root,row,'filename'));
  if(!rootNamesByTrack.has(key))rootNamesByTrack.set(key,new Set());
  rootNamesByTrack.get(key).add(name);
 }
 let comparable=0,mismatches=0;
 for(const target of docs){if(target.id===root.id)continue;if(findFieldIdx(target,'filename')<0)continue;
  for(let r=songStartIdx(target);r<target.records.length;r++){
   const row=target.records[r],key=trackIdentity(target,row);if(key==='\u001f')continue;
   const names=rootNamesByTrack.get(key);if(!names)continue;
   comparable++;if(!names.has(normalize(getVal(target,row,'filename'))))mismatches++;
  }
 }
 const status=mismatches?`${fmtInt(mismatches)} name mismatch${mismatches===1?'':'es'}`:comparable?`${fmtInt(comparable)} compared · OK`:'No shared tracks';
 box.innerHTML=`<div class="cov-label">Filename alignment</div><div class="cov-count${mismatches?' has-mismatch':''}">${esc(status)}</div><p>Compares Artist + Title found in both Root and Targets. Extra entries are ignored.</p>`;
}
function renderSplitChooser(){
 const chooser=$('#splitChooser');chooser.classList.toggle('visible',splitMode);
 if(!splitMode){chooser.innerHTML='';return;}
 chooser.innerHTML=docs.map(d=>`<label class="view-chip" title="Show ${esc(d.filename)} in Split View"><input type="checkbox" data-view="${d.id}" ${viewIds.includes(d.id)?'checked':''}><span>${esc(baseNoExt(d.exportName||d.filename))}</span></label>`).join('');
 $$('#splitChooser [data-view]').forEach(el=>el.addEventListener('change',()=>{
  if(el.checked){if(viewIds.length>=3){el.checked=false;toast('Split view supports up to three files.','error');return;}if(!viewIds.includes(el.dataset.view))viewIds.push(el.dataset.view);}
  else viewIds=viewIds.filter(id=>id!==el.dataset.view);
  if(!viewIds.length){viewIds=[rootId||activeId].filter(Boolean);}
  renderSheets();
 }));
}
function setSplitMode(on){
 if(!commitEdit(null,{refocus:false})){$('#splitToggle').checked=splitMode;return;}
 splitMode=on;
 if(on){const initial=[rootId,activeId,...docs.filter(d=>d.syncTarget).map(d=>d.id)].filter((v,i,a)=>v&&a.indexOf(v)===i);viewIds=initial.slice(0,3);if(!viewIds.length&&docs.length)viewIds=[docs[0].id];}
 renderSplitChooser();renderSheets();focusGrid();
}

/* ---------- sheet area ---------- */
function emptyStateHtml(){
 return `<div class="welcome"><div class="welcome-mark">P</div><h2>Welcome to the Pochita SLK Editor</h2><p>Import one or more <b>.slk</b> files — or drop them anywhere on this page.</p><button type="button" class="btn btn-primary" id="welcomeImport">Import SLK files</button><p class="welcome-hint">Tip: Row 1 &amp; Row 2 show the exact SLK header and type definitions 1:1. Right-click any cell or press Ctrl+Enter to insert new song rows with automatic TBM numbering.</p></div>`;
}
function renderSheets(){
 const grid=$('#sheetGrid'),d=activeDoc();let show=[];
 if(!splitMode){if(d)show=[d];}
 else{viewIds=viewIds.filter((id,i,a)=>docById(id)&&a.indexOf(id)===i).slice(0,3);if(!viewIds.length&&d)viewIds=[d.id];show=viewIds.map(docById).filter(Boolean);}
 for(const g of Object.values(gridById))if(g.el.isConnected){g.st=g.scroller.scrollTop;g.sl=g.scroller.scrollLeft;}
 grid.className='sheet-grid'+(splitMode&&show.length===2?' split-2':splitMode&&show.length>=3?' split-3':'')+(splitMode?' is-split':'');
 if(!show.length){grid.innerHTML=emptyStateHtml();$('#welcomeImport')?.addEventListener('click',()=>$('#filePicker').click());return;}
 const grids=show.map(doc=>{
  const g=gridById[doc.id]||makeGrid(doc);g.rowH=rowHeight();clampSel(doc);buildHead(g,doc);
  g.head.innerHTML=`<div class="sheet-card-title">${isRoot(doc)?'<span class="tab-root"></span>':''}<span class="sheet-name">${esc(baseNoExt(doc.exportName||doc.filename))}</span><span class="sheet-card-sub">${fmtInt(doc.records.length)} rows</span></div><span class="badge ${isRoot(doc)?'root':''}">${isRoot(doc)?'ROOT':'VIEW'}</span>`;
  return g;
 });
 const same=grid.children.length===grids.length&&grids.every((g,i)=>grid.children[i]===g.el);
 if(!same)grid.replaceChildren(...grids.map(g=>g.el));
 document.documentElement.style.setProperty('--row-h',rowHeight()+'px');
 for(const g of grids){
  g.theadH=g.thead.offsetHeight||(HDR1_H+HDR2_H);
  if(!same){g.scroller.scrollTop=g.st;g.scroller.scrollLeft=g.sl;}
  renderViewport(g,true);placeEditor(g);
 }
 markActiveCards();
}

/* ---------- ribbon, help, density ---------- */
function setRibbonTab(name){
 $$('.rtab').forEach(b=>{const on=b.dataset.rtab===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
 $$('.rpanel').forEach(p=>{const on=p.dataset.rpanel===name;p.classList.toggle('active',on);p.hidden=!on;});
 try{localStorage.setItem('pochita-rtab',name);}catch(_){}
}
function setRibbonCollapsed(on){
 $('#ribbon').classList.toggle('collapsed',on);$('#ribbonCollapse').setAttribute('aria-expanded',String(!on));
 try{localStorage.setItem('pochita-ribbon-collapsed',on?'1':'0');}catch(_){}
}
const SHORTCUTS=[
 ['Moving',[['Arrow keys','One cell'],['Tab / Shift+Tab','Next / previous cell, wraps to the next row'],['Enter / Shift+Enter','Down / up — after a Tab chain: back to where you started'],['Ctrl+Arrows','Jump to the first / last row or column'],['Home / End','First / last column of the row'],['Ctrl+Home / Ctrl+End','First / last cell of the table'],['Page Up / Page Down','One screen up / down'],['Name box (top left)','Type C12 or A1:D9 and press Enter to jump there']]],
 ['Selecting',[['Shift+Arrows, Shift+Click','Extend the selection'],['Click and drag','Select a range'],['Ctrl+Click','Add another range'],['Row number / column letter','Select the whole row / column'],['Ctrl+A','Select everything'],['Shift+Space / Ctrl+Space','Select the row / column']]],
 ['Editing & Rows',[['Just start typing','Replace the cell content'],['F2 or double-click','Edit existing content (F2 again switches arrow-key mode)'],['Ctrl+Enter','Insert new song row below with auto-TBM'],['Ctrl+Shift+D','Duplicate selected row(s) and increment TBM'],['Right-click on table','Context menu for rows, columns, and TBM tools'],['Delete','Clear the selected cells'],['Ctrl+C / Ctrl+X / Ctrl+V','Copy, cut, paste — also from and to Excel / LibreOffice'],['Ctrl+D / Ctrl+R','Fill down / right'],['Ctrl+Z / Ctrl+Y','Undo / redo']]],
 ['Search & Help',[['Ctrl+F','Filter rows'],['Ctrl+H','Find & Replace dialog'],['Ctrl+F1','Collapse / expand the ribbon'],['F1','This list']]]
];
function openHelp(){
 $('#helpGrid').innerHTML=SHORTCUTS.map(([title,rows])=>`<section class="help-sec"><h3>${esc(title)}</h3>${rows.map(([k,v])=>`<div class="help-row"><span class="kbd">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</section>`).join('');
 $('#helpModal').classList.add('visible');$('#helpClose').focus();
}
function closeHelp(){$('#helpModal').classList.remove('visible');focusGrid();}
function setCompactMode(compact){
 compactMode=!!compact;document.documentElement.dataset.density=compactMode?'compact':'comfortable';
 const b=$('#compactToggle');if(b)b.setAttribute('aria-pressed',String(compactMode));
 document.documentElement.style.setProperty('--row-h',rowHeight()+'px');
 try{localStorage.setItem('pochita-density',compactMode?'compact':'comfortable');}catch(_){}
 if(typeof appReady!=='undefined'&&appReady){for(const g of Object.values(gridById))g.rowH=rowHeight();renderSheets();}
}
function setToggle(id,on){const b=$('#'+id);if(b)b.setAttribute('aria-pressed',String(!!on));}
function setRoot(id){
 if(!docById(id))return;
 const oldRoot=rootId;rootId=id;if(oldRoot!==id)coverageDismissed=false;
 docs.forEach(d=>{if(d.id===rootId){d.syncTarget=false;}else if(d.id===oldRoot){d.syncTarget=true;}});
 if(!viewIds.includes(rootId)){viewIds=[rootId,...viewIds.filter(x=>x!==rootId)].slice(0,3);}
 if(!activeId)activeId=rootId;
 syncFieldKeys=defaultSyncFieldKeys();
 renderAll();toast(`${baseNoExt(docById(id).exportName)} is now the Root file.`);
}
function resetNewFlags(){
 let changed=0,filesChanged=0;
 const wouldChange=docs.filter(d=>{const index=findFieldIdx(d,'new');return index>=0&&d.records.slice(songStartIdx(d)).some(row=>String(row[index]??'').trim()==='1');});
 const history=wouldChange.length?beginUndo('Set all NEW values to 0',wouldChange):null;
 for(const d of docs){const index=findFieldIdx(d,'new');if(index<0)continue;let local=0;
  for(let r=songStartIdx(d);r<d.records.length;r++){const row=d.records[r];if(String(row[index]??'').trim()==='1'){row[index]='0';local++;}}
  if(local){markDirty(d);changed+=local;filesChanged++;}}
 if(!changed){toast('No NEW = 1 values found in the loaded files.');return;}
 commitUndo(history);renderAll();toast(`Set NEW = 0 for ${changed} row${changed===1?'':'s'} across ${filesChanged} file${filesChanged===1?'':'s'}.`);
}
function trackIdentity(d,row){return [getVal(d,row,'singer'),getVal(d,row,'title')].map(normalize).join('\u001f');}

/* ---------- New Entry Modal ---------- */
function openModal(){
 const d=docById(rootId)||activeDoc();if(!d){toast('Import a file first.','error');return;}
 if(!rootId)rootId=d.id;
 $('#modalEyebrow').textContent=`Root entry · ${baseNoExt(d.exportName||d.filename)}`;
 $('#modalTitle').textContent='Create new entries';
 $('#modalCopy').textContent='Entries are appended in order to the end of Root and enabled target files.';
 $('#formSectionTitle').textContent=`New entries · ${d.headers.length} Root fields`;
 const latest=latestTbmPrefix(d)||'g';
 selectedTbmPrefix=latest||'g';
 renderTbmPrefixOptions(d,selectedTbmPrefix);
 const prefix=prefixValue();entryDrafts=[newEntrySeed(d,nextTbmFilename(d,prefix,0))];
 entryTargetLevels=[Object.fromEntries(targetDocs().filter(t=>findFieldIdx(t,'level')>=0).map(t=>[t.id,String(Math.max(0,Number(t.targetLevel??'3')||0))]))];
 renderEntryDrafts();
 $('#entryModal').classList.add('visible');const first=$('#entryList input:not([readonly])');if(first)first.focus();
}
function renderEntryDrafts(){
 const root=docById(rootId)||activeDoc();if(!root)return;
 const targets=targetDocs().filter(t=>findFieldIdx(t,'level')>=0);
 const filenameIndex=findFieldIdx(root,'filename'),newIndex=findFieldIdx(root,'new'),useIndex=findFieldIdx(root,'use');
 $('#entryList').innerHTML=entryDrafts.map((row,entryIndex)=>{
  const fields=root.headers.map((head,col)=>{
   const type=normalize(root.types[col]||'string'),numeric=type==='int'||type==='float';let value=row[col]??'';
   if(col===newIndex||col===useIndex)value='1';
   const step=type==='int'?'1':type==='float'?'any':null;
   const helper=(col===filenameIndex)?'<span class="field-helper">Auto-generated; editable</span>':((col===newIndex||col===useIndex)?'<span class="field-helper">Editable · starts at 1</span>':'');
   return `<div class="field"><label for="entry_${entryIndex}_${col}">${esc(head||`Column ${col+1}`)}${numeric?` <span class="type-tag">${esc(type)}</span>`:''}</label><input id="entry_${entryIndex}_${col}" data-entry-index="${entryIndex}" data-add-col="${col}" type="${numeric?'number':'text'}" ${step?`step="${step}"`:''} value="${esc(value)}"${col===filenameIndex?' required':''}>${helper}</div>`;
  }).join('');
  const levels=targets.length?`<div class="entry-level-grid">${targets.map(target=>{const value=entryTargetLevels[entryIndex]?.[target.id]??target.targetLevel??'3';return `<div class="field"><label for="entry_${entryIndex}_level_${target.id}">${esc(baseNoExt(target.exportName||target.filename))} · Level</label><input id="entry_${entryIndex}_level_${target.id}" data-entry-index="${entryIndex}" data-entry-level="1" data-target-id="${target.id}" type="number" min="0" step="1" value="${esc(value)}"><span class="field-helper">Minimum 0 · no maximum</span></div>`;}).join('')}</div>`:`<p class="modal-copy">No selected target file has a Level column. You can still add entries to Root.</p>`;
  return `<section class="entry-card" data-entry-card="${entryIndex}" aria-labelledby="entry_card_title_${entryIndex}"><div class="entry-card-head"><div><h3 id="entry_card_title_${entryIndex}">Entry ${entryIndex+1}</h3><p class="modal-copy">${entryIndex===0?'Based on the last entry in Root.':'Based on the entry above; editable before saving.'}</p></div><button type="button" class="btn btn-sm btn-quiet entry-remove" data-remove-entry="${entryIndex}" ${entryDrafts.length===1?'disabled':''}>Remove</button></div><div class="form-section-title">Root fields</div><div class="field-grid">${fields}</div><div class="entry-level-section"><div class="form-section-title">Target levels</div>${levels}</div></section>`;
 }).join('');
 $$('#entryList [data-add-col]').forEach(input=>input.addEventListener('input',()=>{const index=Number(input.dataset.entryIndex),col=Number(input.dataset.addCol);if(entryDrafts[index])entryDrafts[index][col]=input.value;}));
 $$('#entryList [data-entry-level]').forEach(input=>input.addEventListener('input',()=>{const index=Number(input.dataset.entryIndex);entryTargetLevels[index]??={};entryTargetLevels[index][input.dataset.targetId]=String(Math.max(0,Number(input.value)||0));}));
 $$('#entryList [data-remove-entry]').forEach(button=>button.addEventListener('click',()=>{collectEntryDrafts();const index=Number(button.dataset.removeEntry);entryDrafts.splice(index,1);entryTargetLevels.splice(index,1);renderEntryDrafts();}));
 updateEntrySaveLabel();
}
function addAnotherDraft(){
 const root=docById(rootId)||activeDoc();if(!root)return;collectEntryDrafts();
 const previous=entryDrafts[entryDrafts.length-1];
 const prefix=prefixValue(),filenameIndex=findFieldIdx(root,'filename');
 const nextFn=previous&&filenameIndex>=0?incrementTbmFilename(previous[filenameIndex],prefix,root,0):nextTbmFilename(root,prefix,entryDrafts.length);
 const next=newEntrySeed(root,nextFn);
 entryDrafts.push(next);entryTargetLevels.push({...entryTargetLevels[entryTargetLevels.length-1]});
 renderEntryDrafts();const latest=$$('#entryList [data-entry-card]').at(-1);if(latest){latest.scrollIntoView({behavior:'smooth',block:'start'});const first=latest.querySelector('input:not([readonly])');if(first)first.focus({preventScroll:true});}
}
function addEntryFromForm(event){
 event.preventDefault();const source=docById(rootId)||activeDoc();if(!source)return;collectEntryDrafts();
 if(!entryDrafts.length){toast('Add at least one entry first.','error');return;}
 const requiredFields=['singer','title','filename'],seenNames=new Set();
 for(let n=0;n<entryDrafts.length;n++){
  const row=entryDrafts[n];
  for(const field of requiredFields){const col=findFieldIdx(source,field);if(col>=0&&!String(row[col]??'').trim()){toast(`Entry ${n+1}: please complete ${source.headers[col]}.`,'error');return;}}
  const fn=String(row[findFieldIdx(source,'filename')]??'').trim().toLocaleLowerCase();if(fn&&seenNames.has(fn)){toast(`The file name ${fn} is repeated. Each new entry needs its own TBM filename.`,'error');return;}if(fn)seenNames.add(fn);
 }
 let targetsAdded=0,targetsUpdated=0;
 const targets=targetDocs();
 const history=beginUndo('Add new entries',[source,...targets]);
 for(let n=0;n<entryDrafts.length;n++){
  const row=[...entryDrafts[n]];
  source.records.push(row);
  for(const target of targets){const level=entryTargetLevels[n]?.[target.id]??target.targetLevel??'3';const result=upsertToTarget(source,row,target,level);if(result==='added')targetsAdded++;else if(result==='updated')targetsUpdated++;}
 }
 markDirty(source);
 commitUndo(history);
 const lastIndex=source.records.length-1;query='';$('#searchInput').value='';viewStamp++;
 closeModal();activeId=source.id;splitMode=false;$('#splitToggle').checked=false;renderAll();gotoRow(source.id,lastIndex,0);
 toast(`${entryDrafts.length} entr${entryDrafts.length===1?'y':'ies'} added at the end of Root.${targetsAdded?` ${targetsAdded} target entr${targetsAdded===1?'y':'ies'} added.`:''}${targetsUpdated?` ${targetsUpdated} target entr${targetsUpdated===1?'y':'ies'} updated.`:''}`);
 entryDrafts=[];entryTargetLevels=[];
}
function closeModal(){$('#entryModal').classList.remove('visible');focusGrid();}

function syncSelected(){
 const source=docById(rootId);if(!source){toast('Select a Root file first.','error');return;}
 syncFieldKeys=defaultSyncFieldKeys();
 if(!syncFieldKeys.size){toast('No common Artist, Title, File name, BPM or Offset fields were found.','error');return;}
 if(activeId!==rootId){toast('Open the Root tab and select the row(s) you want to apply.','error');return;}
 const rows=selectedModelRows(source).filter(r=>!isMetaRow(r));
 if(!rows.length){toast('Select at least one song row (Row 3+) in Root first.','error');return;}
 const targets=targetDocs();if(!targets.length){toast('Tick at least one Target file on the Root & Targets tab.','error');return;}
 const history=beginUndo('Apply Root row(s) to targets',targets);
 let added=0,updated=0;
 for(const r of rows){
  for(const t of targets){
   const s=upsertToTarget(source,source.records[r],t,null,{matchByTrack:true});
   if(s==='added')added++;else if(s==='updated')updated++;
  }
 }
 commitUndo(history);viewStamp++;renderAll();
 toast(`Applied ${rows.length} Root row${rows.length===1?'':'s'} to targets: ${added} added, ${updated} updated.`);
}

function clearWorkspace(){
 if(!docs.length)return;
 if(!confirm('Remove all files from this workspace? Exported files on your computer will not be changed. Unsaved edits in this session will be discarded.'))return;
 edit=null;docs=[];activeId=null;rootId=null;splitMode=false;viewIds=[];query='';
 for(const id of Object.keys(gridById)){gridById[id].el.remove();delete gridById[id];}
 for(const id of Object.keys(selById))delete selById[id];viewCache.clear();
 dirty.clear();syncFieldKeys.clear();coverageDismissed=false;undoStack=[];redoStack=[];
 $('#searchInput').value='';$('#splitToggle').checked=false;viewStamp++;renderAll();
 updateStatus('Workspace cleared. Import your SLK files to continue.');toast('Workspace cleared. Your original files on disk were not changed.');
}
function localDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function exportCurrent(){const d=activeDoc();if(!d)return;try{const bytes=serializeDoc(d),name=safeSlkName(d.exportName||d.filename);downloadBytes(bytes,name);dirty.delete(d.id);renderAll();toast(`${name} exported.`);}catch(e){toast(e.message,'error');}}
async function exportZip(){if(!docs.length)return;const date=localDate(),folder=`${date}_pochita_export`;try{
 if(typeof JSZip==='undefined')throw new Error('ZIP support could not load. Refresh the page and try again.');
 const zip=new JSZip(),inner=zip.folder(folder),used=new Set();
 for(const d of docs){let name=safeSlkName(d.exportName||d.filename),base=name,number=2;while(used.has(name.toLocaleLowerCase())){name=`${baseNoExt(base)}_${number++}.slk`;}used.add(name.toLocaleLowerCase());inner.file(name,serializeDoc(d));}
 const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});downloadBytes(blob,`${folder}.zip`,'application/zip');dirty.clear();renderAll();toast(`ZIP downloaded: ${folder}.zip`);
 }catch(e){toast(e.message,'error');}}
function safeSlkName(name){let safe=basename(String(name||'export.slk')).replace(/[\/]/g,'_').trim().replace(/^\.+|\.+$/g,'');if(!safe)safe='export.slk';if(/\.txt$/i.test(safe))safe=safe.replace(/\.txt$/i,'.slk');else if(!safe.toLowerCase().endsWith('.slk'))safe+='.slk';return safe;}

function uniqueImportedFilename(filename,reserved){
 const original=basename(filename||'import.slk');
 const dot=original.lastIndexOf('.'),base=dot>0?original.slice(0,dot):original,ext=dot>0?original.slice(dot):'.slk';
 let candidate=original,number=1;
 while(reserved.has(normalize(candidate))){candidate=`${base}_copy${number===1?'':`_${number}`}${ext}`;number++;}
 reserved.add(normalize(candidate));return candidate;
}
async function importFiles(fileList){
 const files=[...(fileList||[])].filter(f=>f&&f.name&&(/\.(?:slk|txt)$/i).test(f.name));
 if(files.length)coverageDismissed=false;
 if(!files.length){toast('Choose one or more .slk files.','error');$('#filePicker').value='';return;}
 updateStatus(`Reading ${files.length} file${files.length===1?'':'s'}…`);
 const addedDocs=[],errors=[],reserved=new Set(docs.map(d=>normalize(d.filename)));
 for(const f of files){
  try{
   const d=parseSlk(f.name,new Uint8Array(await f.arrayBuffer()));
   const uniqueName=uniqueImportedFilename(d.filename,reserved);
   d.filename=uniqueName;d.exportName=uniqueName;d.targetLevel='3';d.syncTarget=true;
   addedDocs.push(d);
   // Start selection at Row 3 (index 2 = first song row) if available.
   const startRow=d.records.length>2?2:0;
   selById[d.id]={a:{p:startRow,c:0},f:{p:startRow,c:0},extra:[]};
  }catch(error){errors.push(`${f.name}: ${error?.message||String(error)}`);}
 }
 if(!addedDocs.length){
  updateStatus('Import failed');toast(errors.slice(0,2).join(' · ')||'No valid files were imported.','error');
  $('#filePicker').value='';return;
 }
 docs.push(...addedDocs);
 if(!rootId&&docs.length){rootId=docs.reduce((a,b)=>b.records.length>a.records.length?b:a).id;docById(rootId).syncTarget=false;if(!activeId)activeId=rootId;}
 if(addedDocs.length===1)activeId=addedDocs[0].id;else if(!activeId&&docs.length)activeId=rootId||docs[docs.length-1].id;
 if(!viewIds.length)viewIds=docs.slice(0,3).map(d=>d.id);
 syncFieldKeys=defaultSyncFieldKeys();
 updateStatus(errors.length?`Imported ${addedDocs.length}; ${errors.length} file(s) could not be read.`:'Files imported');
 viewStamp++;renderAll();focusGrid();
 if(errors.length)toast(`${addedDocs.length} imported, ${errors.length} skipped. ${errors[0]}`,'error');
 else toast(`${addedDocs.length} file${addedDocs.length===1?'':'s'} imported successfully (including Row 1 & 2).`);
 $('#filePicker').value='';
}
function renderAll(){
 renderTabs();renderFiles();renderSplitChooser();renderSheets();renderCoverage();updateTitle();updateStatusRight();updateRibbonState();updateBars();
}

/* ---------- ribbon & modal wiring ---------- */
function onRibbon(id,fn,{refocus=true}={}){
 const el=$('#'+id);if(!el)return;
 el.addEventListener('click',()=>{
  if(edit&&!commitEdit(null,{refocus:false}))return;
  fn();if(refocus)setTimeout(focusGrid,0);
 });
}
onRibbon('addFilesBtn',()=>$('#filePicker').click(),{refocus:false});
onRibbon('sheetAddBtn',()=>$('#filePicker').click(),{refocus:false});
onRibbon('exportCurrentBtn',exportCurrent);
onRibbon('exportZipBtn',exportZip);
onRibbon('undoBtn',undoEdit);
onRibbon('redoBtn',redoEdit);
onRibbon('cutBtn',()=>ribbonCopy(true));
onRibbon('copyBtn',()=>ribbonCopy(false));
onRibbon('pasteBtn',ribbonPaste);
onRibbon('clearBtn',()=>{const g=activeGrid();if(g)clearSelection(g);});
onRibbon('fillDownBtn',()=>{const g=activeGrid();if(g)fillSelection(g,'down');});
onRibbon('fillRightBtn',()=>{const g=activeGrid();if(g)fillSelection(g,'right');});
onRibbon('newEntryBtn',openModal,{refocus:false});
onRibbon('insertRowBelowBtn',()=>insertRowInTable('below'));
onRibbon('insertRowAboveBtn',()=>insertRowInTable('above'));
onRibbon('dupRowBtn',duplicateSelectedRows);
onRibbon('deleteRowBtn',deleteSelectedRows);
onRibbon('insertColRightBtn',()=>openColModal('right'),{refocus:false});
onRibbon('insertColLeftBtn',()=>openColModal('left'),{refocus:false});
onRibbon('deleteColBtn',deleteActiveColumn);
onRibbon('autoTbmBtn',assignAutoTbmToSelection);
onRibbon('checkIssuesBtn',openIssuesModal,{refocus:false});
onRibbon('replaceModalBtn',openReplaceModal,{refocus:false});
onRibbon('toggleSelectedNewBtn',()=>toggleSelectedField('new'));
onRibbon('toggleSelectedUseBtn',()=>toggleSelectedField('use'));
onRibbon('resetNewFlagsBtn',()=>{resetNewFlags();});
onRibbon('syncBtn',syncSelected);
onRibbon('resetDemoBtn',clearWorkspace);
onRibbon('shortcutsBtn',openHelp,{refocus:false});
onRibbon('compactToggle',()=>setCompactMode(!compactMode));
onRibbon('freezeToggle',()=>{freezeCols=!freezeCols;setToggle('freezeToggle',freezeCols);try{localStorage.setItem('pochita-freeze',freezeCols?'1':'0');}catch(_){}renderSheets();});
onRibbon('crossToggle',()=>{crosshair=!crosshair;setToggle('crossToggle',crosshair);try{localStorage.setItem('pochita-cross',crosshair?'1':'0');}catch(_){}paintAll();});
onRibbon('autoFitBtn',()=>{const d=activeDoc();if(!d)return;d.colW=autoFitWidths(d);saveWidths(d);renderSheets();flashStatus('Column widths fitted to their content.');});
$$('.rtab').forEach(b=>b.addEventListener('click',()=>{if($('#ribbon').classList.contains('collapsed'))setRibbonCollapsed(false);setRibbonTab(b.dataset.rtab);}));
$$('.rtab').forEach(b=>b.addEventListener('dblclick',()=>setRibbonCollapsed(!$('#ribbon').classList.contains('collapsed'))));
$('#ribbonCollapse').addEventListener('click',()=>setRibbonCollapsed(!$('#ribbon').classList.contains('collapsed')));

$('#filePicker').addEventListener('change',event=>importFiles(event.target.files));
$('#splitToggle').addEventListener('change',event=>setSplitMode(event.target.checked));
$('#enterEdits').addEventListener('change',event=>{enterEdits=event.target.checked;try{localStorage.setItem('pochita-enter-edits',enterEdits?'1':'0');}catch(_){}focusGrid();});
$('#searchInput').addEventListener('input',event=>{
 if(edit&&!commitEdit(null,{refocus:false}))return;
 query=event.target.value;viewStamp++;
 for(const id of Object.keys(selById)){const s=selById[id];s.a={p:0,c:s.a.c};s.f={p:0,c:s.a.c};s.extra=[];}
 for(const g of Object.values(gridById)){g.st=0;g.scroller.scrollTop=0;}
 renderSheets();updateRibbonState();updateBars();
});
$('#searchInput').addEventListener('keydown',e=>{
 if(e.key==='Enter'){e.preventDefault();focusGrid();}
 else if(e.key==='Escape'){e.preventDefault();if(e.target.value){e.target.value='';e.target.dispatchEvent(new Event('input'));}focusGrid();}
});
$('#entryForm').addEventListener('submit',addEntryFromForm);
$('#addAnotherEntry').addEventListener('click',addAnotherDraft);
$('#tbmPrefixSelect').addEventListener('change',()=>{const custom=$('#tbmPrefixSelect').value==='__custom__';$('#customPrefixField').hidden=!custom;if(custom){$('#tbmCustomPrefix').focus();}else{recalculateEntryFilenames();}});
$('#tbmCustomPrefix').addEventListener('change',recalculateEntryFilenames);
$('#modalClose').addEventListener('click',closeModal);
$('#cancelEntryBtn').addEventListener('click',closeModal);
$('#entryModal').addEventListener('click',event=>{if(event.target===$('#entryModal'))closeModal();});
$('#helpClose').addEventListener('click',closeHelp);
$('#helpModal').addEventListener('click',event=>{if(event.target===$('#helpModal'))closeHelp();});
$('#colForm').addEventListener('submit',handleInsertColumn);
$('#colModalClose').addEventListener('click',closeColModal);
$('#colCancelBtn').addEventListener('click',closeColModal);
$('#colModal').addEventListener('click',e=>{if(e.target===$('#colModal'))closeColModal();});
$('#replaceForm').addEventListener('submit',handleReplaceAll);
$('#replaceModalClose').addEventListener('click',closeReplaceModal);
$('#replaceCancelBtn').addEventListener('click',closeReplaceModal);
$('#replaceModal').addEventListener('click',e=>{if(e.target===$('#replaceModal'))closeReplaceModal();});
$('#issuesModalClose').addEventListener('click',()=>{$('#issuesModal').classList.remove('visible');focusGrid();});
$('#issuesDoneBtn').addEventListener('click',()=>{$('#issuesModal').classList.remove('visible');focusGrid();});
$('#issuesModal').addEventListener('click',e=>{if(e.target===$('#issuesModal')){$('#issuesModal').classList.remove('visible');focusGrid();}});

/* ---------- global keyboard ---------- */
document.addEventListener('keydown',event=>{
 hideContextMenu();
 if(event.key==='Escape'){
  if($('#entryModal').classList.contains('visible')){closeModal();return;}
  if($('#helpModal').classList.contains('visible')){closeHelp();return;}
  if($('#colModal').classList.contains('visible')){closeColModal();return;}
  if($('#replaceModal').classList.contains('visible')){closeReplaceModal();return;}
  if($('#issuesModal').classList.contains('visible')){$('#issuesModal').classList.remove('visible');focusGrid();return;}
 }
 if(anyModalOpen())return;
 if(event.key==='F1'){event.preventDefault();if(event.ctrlKey)setRibbonCollapsed(!$('#ribbon').classList.contains('collapsed'));else openHelp();return;}
 const t=event.target,ctrl=event.ctrlKey||event.metaKey;
 const onBody=t===document.body||t===document.documentElement||(t.closest&&t.closest('.grid-scroll')&&!t.classList.contains('cell-editor'));
 if(onBody&&!edit){
  const g=activeGrid();if(!g)return;
  if(event.key.length===1&&!ctrl&&!event.altKey){event.preventDefault();beginEdit(g,'enter',{value:event.key});return;}
  if(ctrl||/^(Arrow|Tab|Enter|F2|Home|End|Page|Delete|Backspace|Escape| )/.test(event.key)){focusGrid();gridKey(g,event);}
  return;
 }
 if(ctrl&&!event.altKey&&t.matches&&!t.matches('input,textarea,select')){
  const lk=event.key.toLowerCase();
  if(lk==='z'){event.preventDefault();event.shiftKey?redoEdit():undoEdit();}
  else if(lk==='y'){event.preventDefault();redoEdit();}
  else if(lk==='f'){event.preventDefault();$('#searchInput').focus();$('#searchInput').select();}
  else if(lk==='h'){event.preventDefault();openReplaceModal();}
 }
});

/* ---------- drag & drop import, leave-warning, resize ---------- */
window.addEventListener('dragover',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files')){e.preventDefault();document.body.classList.add('dropping');}});
window.addEventListener('dragleave',e=>{if(e.relatedTarget===null)document.body.classList.remove('dropping');});
window.addEventListener('drop',e=>{document.body.classList.remove('dropping');if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length){e.preventDefault();importFiles(e.dataTransfer.files);}});
window.addEventListener('beforeunload',e=>{if(dirty.size){e.preventDefault();e.returnValue='';}});
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{for(const g of Object.values(gridById))if(g.el.isConnected){renderViewport(g,true);placeEditor(g);}},80);});

/* =====================================================================
   4 Curated Color Themes:
   - Dark:  Catppuccin Mocha (default), Nord
   - Light: Catppuccin Latte, Cloud
   ===================================================================== */
const COLOR_THEMES={
 'Catppuccin Mocha':['#181825','#1e1e2e','#313244','#45475a','rgba(203,166,247,.05)','rgba(137,180,250,.04)','#cba6f7','#cdd6f4','#181825'],
 'Nord':['#242933','#2e3440','#3b4252','#434c5e','rgba(136,192,208,.05)','rgba(129,161,193,.04)','#88c0d0','#eceff4','#292e39'],
 'Catppuccin Latte':['#e6e9ef','#eff1f5','#dce0e8','#ccd0da','rgba(136,57,239,.05)','rgba(30,102,245,.04)','#8839ef','#4c4f69','#e6e9ef'],
'Cloud':['#eceff3','#e7ebf0','#e2e7ed','#dce2ea','rgba(74,111,165,.06)','rgba(122,95,160,.05)','#3f649c','#2b3340','#e5e9ef']
};
const THEME_KEYS=['--wd-night','--wd-blue','--wd-violet','--wd-wine','--wd-glow-top','--wd-glow-bottom','--wd-accent','--wd-text','--wd-panel'];
function themeIsLight(name){return name==='Catppuccin Latte'||name==='Cloud';}
function setTheme(theme){
 const name=COLOR_THEMES[theme]?theme:'Catppuccin Mocha',c=COLOR_THEMES[name],root=document.documentElement,light=themeIsLight(name);
 root.dataset.theme=light?'light':'dark';root.dataset.palette=name;
 THEME_KEYS.forEach((key,i)=>root.style.setProperty(key,c[i]));
 const text=c[7],night=c[0],panel=c[8],border=light?'rgba(45,42,38,.15)':'rgba(205,214,244,.15)';
 root.style.setProperty('--ink',text);root.style.setProperty('--slate',c[1]);root.style.setProperty('--green',c[6]);root.style.setProperty('--mint',light?'#f5e0dc':text);root.style.setProperty('--canvas',night);root.style.setProperty('--panel',panel);root.style.setProperty('--muted',light?'#6c6f85':'#a6adc8');root.style.setProperty('--line',border);root.style.setProperty('--line-strong',light?'rgba(45,42,38,.26)':'rgba(205,214,244,.26)');root.style.setProperty('--button-text',light?'#ffffff':'#11111b');root.style.setProperty('--theme-muted',light?'#6c6f85':'#a6adc8');
 $('#currentThemeName')?.replaceChildren(document.createTextNode(name));const swatch=$('#themeOpenSwatch');if(swatch){swatch.style.background=c[6];swatch.style.boxShadow=`inset 0 0 0 1px ${light?'rgba(0,0,0,.25)':'rgba(255,255,255,.3)'}`;}
 $$('#themeModalGrid .theme-card').forEach(card=>{card.setAttribute('aria-pressed',String(card.dataset.themeName===name));card.classList.toggle('selected',card.dataset.themeName===name);});
 const meta=$('meta[name=theme-color]');if(meta)meta.setAttribute('content',night);
 try{localStorage.setItem('pochita-theme',name);}catch(_){}
}
function renderThemeCards(){
 const grid=$('#themeModalGrid');if(!grid)return;
 grid.innerHTML=Object.entries(COLOR_THEMES).map(([name,c])=>{
  const light=themeIsLight(name),fg=c[7],bg=c[0],panel=c[8],accent=c[6],line=light?'rgba(45,42,38,.16)':'rgba(205,214,244,.16)';
  return `<button type="button" class="theme-card" data-theme-name="${esc(name)}" aria-pressed="false" aria-label="Use ${esc(name)} theme">
   <div class="theme-preview" style="--preview-bg:${bg};--preview-panel:${panel};--preview-fg:${fg};--preview-accent:${accent};--preview-line:${line}">
    <div class="theme-preview-top"><span class="theme-preview-logo"></span><span class="theme-preview-brand"></span><span class="theme-preview-pill"></span></div>
    <div class="theme-preview-body"><div class="theme-preview-side"><i></i><i></i><i></i><i></i></div><div class="theme-preview-main"><div class="theme-preview-title"></div><div class="theme-preview-tabs"><i></i><i></i><i></i></div><div class="theme-preview-table"><div class="theme-preview-th"><i></i><i></i><i></i></div><div class="theme-preview-tr"><i></i><i></i><i></i></div><div class="theme-preview-tr"><i></i><i></i><i></i></div><div class="theme-preview-tr"><i></i><i></i><i></i></div></div></div></div>
   </div><div class="theme-card-meta"><div><span class="theme-card-name">${esc(name)}</span><span class="theme-card-mode">${light?'Light':'Dark'}</span></div><span class="theme-card-dot" style="background:${accent}"></span></div>
  </button>`;
 }).join('');
 grid.querySelectorAll('.theme-card').forEach(card=>card.addEventListener('click',()=>{setTheme(card.dataset.themeName);closeThemeModal();}));
}
function openThemeModal(){const modal=$('#themeModal');if(!modal)return;renderThemeCards();modal.hidden=false;document.body.classList.add('theme-modal-open');$('#themeModalClose').focus();}
function closeThemeModal(){const modal=$('#themeModal');if(!modal)return;modal.hidden=true;document.body.classList.remove('theme-modal-open');$('#themeOpenBtn').focus();}
$('#themeOpenBtn')?.addEventListener('click',openThemeModal);$('#themeModalClose')?.addEventListener('click',closeThemeModal);$('#themeModalDone')?.addEventListener('click',closeThemeModal);$('#themeModal')?.addEventListener('click',e=>{if(e.target===$('#themeModal'))closeThemeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#themeModal').hidden)closeThemeModal();});
renderThemeCards();
let savedTheme='Catppuccin Mocha';try{const stored=localStorage.getItem('pochita-theme');if(stored&&COLOR_THEMES[stored])savedTheme=stored;}catch(_){}
setTheme(savedTheme);

/* ---------- init ---------- */
(function restorePrefs(){
 try{
  freezeCols=localStorage.getItem('pochita-freeze')==='1';
  crosshair=localStorage.getItem('pochita-cross')!=='0';
  enterEdits=localStorage.getItem('pochita-enter-edits')==='1';
  setRibbonTab(localStorage.getItem('pochita-rtab')||'home');
  setRibbonCollapsed(localStorage.getItem('pochita-ribbon-collapsed')==='1');
 }catch(_){}
 setToggle('freezeToggle',freezeCols);setToggle('crossToggle',crosshair);$('#enterEdits').checked=enterEdits;
})();
setCompactMode(compactMode);
renderAll();updateStatus('Import one or more SLK files to get started.');
appReady=true;