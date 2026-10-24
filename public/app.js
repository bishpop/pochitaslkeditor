const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let docs = [], activeId = null, rootId = null, splitMode = false, viewIds = [], query = '', pageById = {}, selectedRowById = {}, selectedRowsById = {}, selectedCellById = {}, selectionAnchorById = {}, dirty = new Set();
let syncFieldKeys = new Set();
let viewMode = 'paged', pageSize = 100, f2Enabled = true, dragSelectEnabled = true, dragSelection = null;
let entryDrafts = [], entryTargetLevels = [], selectedTbmPrefix = 'g';
const SYNC_FIELD_CANDIDATES = [
 {key:'singer', label:'Singer / Artist'}, {key:'title', label:'Title'}, {key:'filename', label:'File name'},
 {key:'bpm', label:'BPM'}, {key:'offset', label:'Offset'}, {key:'new', label:'New'}, {key:'use', label:'Use'}
];
const CELL_RE = /^C;X(\d+);Y(\d+);K(.*)$/;
const iconSvg = {
 file:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 3.5h7l4.5 4.5v12A1.5 1.5 0 0 1 17 21.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M14 4v4h4M8.5 12h7M8.5 15.5h7"/></svg>',
 check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m5 12 4.2 4.2L19 6.8"/></svg>',
 search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>'
};
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function basename(s){return String(s||'file.slk').split(/[\\/]/).pop();}
function baseNoExt(s){return basename(s).replace(/\.slk$/i,'');}
function docById(id){return docs.find(d=>d.id===id);}
function activeDoc(){return docById(activeId);}
function isRoot(d){return !!d && d.id===rootId;}
function normalize(s){return String(s??'').trim().toLocaleLowerCase();}
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
 // The uploaded Korean headers may use CP949; decoding is handled in the browser, with fallbacks preserving the supplied schema order.
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
function defaultValue(type,header=''){
 const t=normalize(type), h=normalize(header);
 if(t==='string'){
  if(h==='info')return '';
  return '';
 }
 if(h==='use'||h==='사용여부')return '1';
 return '0';
}
function identity(d,row){return [getVal(d,row,'singer'),getVal(d,row,'title'),getVal(d,row,'filename')].map(normalize).join('\u001f');}
function rowDefaults(d){
 const sample=(d.records&&d.records[0])||[];
 return d.headers.map((head,i)=>{
  let t=normalize(d.types[i]||'string');
  if(i===findFieldIdx(d,'use')) return sample[i]!==undefined&&sample[i]!==''?sample[i]:'1';
  if(t==='string') return '';
  return '0';
 });
}
function canonicalValue(source,row,field){return getVal(source,row,field);}
function writeField(targetRow,targetDoc,field,value){const i=findFieldIdx(targetDoc,field);if(i>=0&&i<targetRow.length)targetRow[i]=String(value??'');}
function mapRow(sourceDoc,sourceRow,targetDoc,targetLevel=null){
 let out=rowDefaults(targetDoc);
 for(const f of ['singer','title','filename','bpm','offset','new','use','hard','startMadi','endMadi','info','money','cash','charge','bgm','bgmMaster']){
  const si=findFieldIdx(sourceDoc,f), ti=findFieldIdx(targetDoc,f);
  if(si>=0&&ti>=0)out[ti]=String(sourceRow[si]??'');
 }
 const levelIdx=findFieldIdx(targetDoc,'level');
 if(levelIdx>=0){
   if(targetLevel!==null&&targetLevel!==undefined)out[levelIdx]=String(targetLevel);
   else {const srcLevel=findFieldIdx(sourceDoc,'level');out[levelIdx]=srcLevel>=0?String(sourceRow[srcLevel]??'3'):'3';}
 }
 return out;
}
function parseTbmName(value){
 const match=String(value??'').trim().match(/^(.*?)(\d+)(\.tbm)$/i);
 return match?{prefix:match[1],number:Number(match[2]),width:match[2].length,suffix:match[3]}:null;
}
function availableTbmPrefixes(doc){
 const values=[];const index=findFieldIdx(doc,'filename');
 if(index>=0){for(const row of doc.records){const parsed=parseTbmName(row[index]);if(parsed&&!values.includes(parsed.prefix))values.push(parsed.prefix);}}
 return values;
}
function latestTbmPrefix(doc){
 const index=findFieldIdx(doc,'filename');if(index<0)return '';
 for(let i=doc.records.length-1;i>=0;i--){const parsed=parseTbmName(doc.records[i][index]);if(parsed)return parsed.prefix;}
 return '';
}
function latestTbmForPrefix(doc,prefix){
 const index=findFieldIdx(doc,'filename');if(index<0)return null;
 for(let i=doc.records.length-1;i>=0;i--){const parsed=parseTbmName(doc.records[i][index]);if(parsed&&parsed.prefix===prefix)return parsed;}
 return null;
}
function nextTbmFilename(doc,prefix,offset=0){
 const latest=latestTbmForPrefix(doc,prefix);const width=latest?.width||4;const suffix=latest?.suffix||'.tbm';const number=(latest?latest.number:0)+1+offset;
 return `${prefix}${String(number).padStart(width,'0')}${suffix}`;
}
function incrementTbmFilename(filename,prefix,doc,offset=0){
 const parsed=parseTbmName(filename);
 if(parsed)return `${parsed.prefix}${String(parsed.number+1+offset).padStart(parsed.width,'0')}${parsed.suffix}`;
 return nextTbmFilename(doc,prefix,offset);
}
function newEntrySeed(doc,filename){
 const source=doc.records.length?doc.records[doc.records.length-1]:rowDefaults(doc);
 const row=[...source,...Array(Math.max(0,doc.headers.length-source.length)).fill('')].slice(0,doc.headers.length);
 const offsetIndex=findFieldIdx(doc,'offset'),newIndex=findFieldIdx(doc,'new'),useIndex=findFieldIdx(doc,'use'),filenameIndex=findFieldIdx(doc,'filename');
 if(offsetIndex>=0)row[offsetIndex]='0.7';
 if(newIndex>=0)row[newIndex]='1';
 if(useIndex>=0)row[useIndex]='1';
 if(filenameIndex>=0&&filename)row[filenameIndex]=filename;
 return row;
}
function prefixValue(){
 const selected=$('#tbmPrefixSelect')?.value||selectedTbmPrefix;
 if(selected==='__custom__')return String($('#tbmCustomPrefix')?.value||'g').trim();
 return selected;
}
function setDraftFilename(draft,doc,filename){const i=findFieldIdx(doc,'filename');if(i>=0)draft[i]=filename;}
function collectEntryDrafts(){
 const doc=docById(rootId);if(!doc)return;
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
 const doc=docById(rootId);if(!doc||!entryDrafts.length)return;
 const prefix=prefixValue();if(!prefix){toast('Enter a TBM prefix first.','error');return;}
 selectedTbmPrefix=prefix;
 entryDrafts.forEach((draft,index)=>setDraftFilename(draft,doc,nextTbmFilename(doc,prefix,index)));
 renderEntryDrafts();
}
function makeTargetRow(sourceDoc,sourceRow,targetDoc,targetLevelOverride=null){
 const out=rowDefaults(targetDoc);
 // Identity columns must be present on newly-created target rows, even when not selected in field sync.
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
function upsertToTarget(sourceDoc,sourceRow,targetDoc,targetLevelOverride=null){
 const ident=identity(sourceDoc,sourceRow);
 const levelIdx=findFieldIdx(targetDoc,'level');
 const desiredLevel=levelIdx>=0?String(targetLevelOverride??targetDoc.targetLevel??'3'):null;
 let found=-1;
 for(let i=0;i<targetDoc.records.length;i++){
  if(identity(targetDoc,targetDoc.records[i])!==ident)continue;
  if(desiredLevel!==null && String(targetDoc.records[i][levelIdx])!==desiredLevel)continue;
  found=i;break;
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
function markDirty(d){dirty.add(d.id);d.rowCount=d.records.length;}
function makeId(){return (globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():`doc_${Date.now()}_${Math.random().toString(16).slice(2)}`;}
function decodeSlkBytes(raw){
 const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);
 if(bytes.length>=3&&bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF)return {text:new TextDecoder('utf-8').decode(bytes),encoding:'utf-8-sig'};
 try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),encoding:'utf-8'};}catch{}
 return {text:PochitaCP949.decode(bytes),encoding:'cp949'};
}
function unquoteSlk(value){return value.length>=2&&value[0]==='"'&&value[value.length-1]==='"'?value.slice(1,-1).replace(/""/g,'"'):value;}
function parseSlk(name,raw){
 const decoded=decodeSlkBytes(raw),text=decoded.text,newline=text.includes('\r\n')?'\r\n':'\n';
 const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');if(lines.length&&lines[lines.length-1]==='')lines.pop();
 const idLine=lines.find(line=>line.startsWith('ID'))||'ID;PCALCOOO32',endLine=[...lines].reverse().find(line=>line==='E')||'E';
 const cells={};
 for(const line of lines){const m=CELL_RE.exec(line);if(!m)continue;const x=Number(m[1]),y=Number(m[2]);cells[y]??={};cells[y][x]=unquoteSlk(m[3]);}
 const ys=Object.keys(cells).map(Number);if(!cells[1]||!cells[2])throw new Error(`${name}: No valid SLK header row found.`);
 const maxCol=Math.max(0,...Object.values(cells).map(row=>Math.max(0,...Object.keys(row).map(Number))));const maxRow=Math.max(...ys);
 const headers=Array.from({length:maxCol},(_,i)=>cells[1][i+1]??`Column ${i+1}`);
 const types=Array.from({length:maxCol},(_,i)=>cells[2][i+1]??'string');
 const records=[];for(let y=3;y<=maxRow;y++)records.push(Array.from({length:maxCol},(_,i)=>cells[y]?.[i+1]??''));
 while(records.length&&!records[records.length-1].some(v=>String(v).trim()))records.pop();
 return {id:makeId(),filename:basename(name),exportName:basename(name),encoding:decoded.encoding,newline,idLine,endLine,headers,types,records,rowCount:records.length,columnCount:maxCol};
}
function quoteSlk(value){return '"'+String(value??'').replace(/"/g,'""')+'"';}
function numericSlk(value,kind,rowNo,colNo){
 let raw=String(value??'').trim();if(!raw)raw='0';raw=raw.replace(/,/g,'.');const number=Number(raw);
 if(!Number.isFinite(number))throw new Error(`Row ${rowNo}, column ${colNo}: “${value}” is not a valid number.`);
 if(String(kind).toLowerCase()==='int')return String(Math.trunc(number));
 return String(Number(number.toPrecision(12)));
}
function encodeSlkText(text,encoding){
 if(encoding==='utf-8-sig'){const body=new TextEncoder().encode(text),out=new Uint8Array(body.length+3);out.set([0xEF,0xBB,0xBF]);out.set(body,3);return out;}
 if(encoding==='utf-8')return new TextEncoder().encode(text);
 if(encoding==='cp949')return PochitaCP949.encode(text);
 throw new Error(`Unsupported source encoding “${encoding}”. Export cancelled to avoid damaging the file.`);
}
function serializeDoc(doc){
 const headers=[...(doc.headers||[])],width=headers.length;if(!width)throw new Error('This SLK file has no columns.');
 const types=([...(doc.types||[]),...Array(width).fill('string')]).slice(0,width);
 const lines=[doc.idLine||'ID;PCALCOOO32'],rows=[headers,types,...(doc.records||[])];
 rows.forEach((row,y)=>{const values=[...(row||[]),...Array(width).fill('')].slice(0,width);values.forEach((value,x)=>{
  const kind=String(types[x]||'string').toLowerCase();let encoded;
  if(y<2||kind==='string')encoded=quoteSlk(value);else encoded=numericSlk(value,kind,y+1,x+1);
  lines.push(`C;X${x+1};Y${y+1};K${encoded}`);
 });});
 lines.push(doc.endLine||'E');return encodeSlkText(lines.join(doc.newline||'\r\n')+(doc.newline||'\r\n'),doc.encoding||'cp949');
}
function downloadBytes(bytes,name,mime='application/octet-stream'){
 const blob=new Blob([bytes],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function syncFieldOptions(){
 const root=docById(rootId);if(!root)return [];
 const targets=docs.filter(d=>d.id!==rootId);
 return SYNC_FIELD_CANDIDATES.filter(f=>findFieldIdx(root,f.key)>=0&&targets.some(d=>findFieldIdx(d,f.key)>=0));
}
function renderSyncFields(){
 const panel=$('#syncFieldsPanel'),host=$('#syncFieldList');if(!rootId||!docById(rootId)){panel.classList.add('sync-hidden');host.innerHTML='<span class="sync-empty">Choose a Root file to configure field-level sync.</span>';return;}
 panel.classList.remove('sync-hidden');const fields=syncFieldOptions();
 if(!fields.length){host.innerHTML='<span class="sync-empty">No common fields found. Import a target SLK to configure selective sync.</span>';return;}
 host.innerHTML=fields.map(f=>`<label class="sync-field"><input type="checkbox" data-sync-field="${f.key}" ${syncFieldKeys.has(f.key)?'checked':''}><span>${esc(f.label)}</span></label>`).join('');
 $$('[data-sync-field]',host).forEach(input=>input.addEventListener('change',()=>{input.checked?syncFieldKeys.add(input.dataset.syncField):syncFieldKeys.delete(input.dataset.syncField);$('#clearSyncFields').disabled=syncFieldKeys.size===0;updateHead();}));
 $('#selectAllSyncFields').disabled=!fields.length;$('#clearSyncFields').disabled=syncFieldKeys.size===0;
}
function toast(message,kind='ok'){
 const node=document.createElement('div');node.className='toast';node.innerHTML=`<span class="toast-mark">${kind==='error'?'!':'✓'}</span><span>${esc(message)}</span>`;$('#toastWrap').append(node);setTimeout(()=>node.remove(),4800);
}
function updateStatus(text){$('#statusText').textContent=text;}
function targetDocs(){return docs.filter(d=>d.id!==rootId&&d.syncTarget);}
function renderSidebar(){
 $('#fileCount').textContent=`${docs.length} file${docs.length===1?'':'s'}`;$('#resetDemoBtn').disabled=!docs.length;
 $('#fileList').innerHTML=docs.map(d=>{
  const selected=d.id===activeId, root=d.id===rootId, kind=kindOf(d);
  return `<div class="file-item ${selected?'active':''}">
    <div class="file-top">
      <button type="button" class="root-pick ${root?'selected':''}" data-root="${d.id}" title="Make this file the single Root"><span class="root-box">✓</span><span>Root</span></button>
      <button type="button" class="file-open" data-open="${d.id}" title="Open ${esc(d.filename)}">${esc(baseNoExt(d.exportName||d.filename))}</button>
      <label class="target-check" title="Include this file when applying selected Root fields"><input type="checkbox" data-target="${d.id}" ${d.syncTarget?'checked':''} ${root?'disabled':''}><span>Target</span></label>
    </div>
    <div class="file-meta"><span>${esc(labelForKind(kind))}</span><span>${d.records.length.toLocaleString('en-US')} rows · ${d.headers.length} cols <button type="button" class="file-remove" data-remove="${d.id}" title="Remove from workspace only">×</button></span></div>
    <div class="file-bottom"><span class="file-tag">${root?'ROOT SOURCE':d.syncTarget?'TARGET ENABLED':'AVAILABLE'}</span>${root?'':`<label class="level-editor">Level <input type="number" min="0" step="1" data-level="${d.id}" value="${esc(d.targetLevel??'3')}" ${findFieldIdx(d,'level')<0?'disabled title="This file has no Level column"':''}></label>`}</div>
   </div>`;
 }).join('');
 $$('#fileList [data-open]').forEach(b=>b.addEventListener('click',()=>{activeId=b.dataset.open;renderAll();}));
 $$('#fileList [data-root]').forEach(b=>b.addEventListener('click',()=>setRoot(b.dataset.root)));
 $$('#fileList [data-target]').forEach(el=>el.addEventListener('change',()=>{const d=docById(el.dataset.target);if(d){d.syncTarget=el.checked;renderAll();}}));
 $$('#fileList [data-level]').forEach(el=>el.addEventListener('change',()=>{const d=docById(el.dataset.level);if(d){d.targetLevel=String(Math.max(0,Number(el.value)||0));el.value=d.targetLevel;}}));
 $$('#fileList [data-remove]').forEach(b=>b.addEventListener('click',()=>removeDoc(b.dataset.remove)));
}
function removeDoc(id){
 const d=docById(id);if(!d)return;
 if(!confirm(`Remove ${d.filename} from this workspace? The original file on disk will not be changed.`))return;
 docs=docs.filter(x=>x.id!==id);dirty.delete(id);delete pageById[id];delete selectedRowById[id];viewIds=viewIds.filter(x=>x!==id);
 if(activeId===id)activeId=docs[0]?.id||null;
 if(rootId===id){const next=docs.find(x=>kindOf(x)==='root')||[...docs].sort((a,b)=>b.records.length-a.records.length)[0];rootId=next?.id||null;syncFieldKeys.clear();docs.forEach(x=>{x.syncTarget=x.id!==rootId;});}
 if(rootId){const root=docById(rootId);if(root)root.syncTarget=false;}
 if(!viewIds.length&&docs.length)viewIds=docs.slice(0,Math.min(3,docs.length)).map(x=>x.id);
 renderAll();toast(`${d.filename} removed from workspace.`);
}
function setRoot(id){
 if(!docById(id))return;
 const oldRoot=rootId;rootId=id;if(oldRoot!==id)syncFieldKeys.clear();
 docs.forEach(d=>{if(d.id===rootId){d.syncTarget=false;}else if(d.id===oldRoot){d.syncTarget=true;}});
 if(!viewIds.includes(rootId)){viewIds=[rootId,...viewIds.filter(x=>x!==rootId)].slice(0,3);}
 if(!activeId)activeId=rootId;
 renderAll();toast(`${baseNoExt(docById(id).exportName)} ist jetzt die Root-Datei.`);
}
function renderTabs(){
 $('#tabs').innerHTML=docs.map(d=>`<button type="button" class="tab ${d.id===activeId?'active':''}" data-tab="${d.id}" title="${esc(d.filename)}">${d.id===rootId?'<span class="tab-root"></span>':''}<span class="tab-name">${esc(baseNoExt(d.exportName||d.filename))}</span>${dirty.has(d.id)?'<span class="dirty-dot" aria-label="Unsaved changes">•</span>':''}</button>`).join('');
 $$('#tabs [data-tab]').forEach(b=>b.addEventListener('click',()=>{activeId=b.dataset.tab;renderAll();}));
}
function updateHead(){
 const d=activeDoc();
 if(!d){$('#pageTitle').textContent='Pochita SLK Editor';$('#pageSubtitle').innerHTML='Load one or more SLK files to get started.';$('#newEntryBtn').disabled=true;$('#syncBtn').disabled=true;$('#exportCurrentBtn').disabled=true;$('#exportZipBtn').disabled=!docs.length;$('#statusRight').textContent='Import SLK files to start editing. Files stay in this browser session until exported.';return;}
 $('#pageTitle').textContent=baseNoExt(d.exportName||d.filename);
 $('#headerFileKind').textContent=labelForKind(kindOf(d));
 $('#pageSubtitle').innerHTML=`<span>${d.records.length.toLocaleString('en-US')} entries</span><span>·</span><span>${d.headers.length} columns</span><span>·</span><span>${esc(d.encoding)}</span>${isRoot(d)?'<span class="badge root">ROOT SOURCE</span>':''}${dirty.has(d.id)?'<span class="badge changed">Unsaved changes</span>':''}`;
 $('#newEntryBtn').disabled=!d;
 $('#syncBtn').disabled=!docById(rootId)||!targetDocs().length||syncFieldKeys.size===0;
 $('#exportCurrentBtn').disabled=!d;
 $('#exportZipBtn').disabled=!docs.length;
 $('#statusRight').textContent=dirty.size?`${dirty.size} file${dirty.size===1?'':'s'} changed · Export to keep your changes.`:'Changes stay in this local session until exported.';
}
function renderSplitChooser(){
 const chooser=$('#splitChooser');chooser.classList.toggle('visible',splitMode);
 if(!splitMode){chooser.innerHTML='';return;}
 chooser.innerHTML=docs.map(d=>`<label class="view-chip" title="Show ${esc(d.filename)} in Split View"><input type="checkbox" data-view="${d.id}" ${viewIds.includes(d.id)?'checked':''}><span>${esc(baseNoExt(d.exportName||d.filename))}</span></label>`).join('');
 $$('#splitChooser [data-view]').forEach(el=>el.addEventListener('change',()=>{
   if(el.checked){if(viewIds.length>=3){el.checked=false;toast('Split View unterstützt maximal drei Dateien.','error');return;}if(!viewIds.includes(el.dataset.view))viewIds.push(el.dataset.view);}
   else viewIds=viewIds.filter(id=>id!==el.dataset.view);
   if(!viewIds.length){viewIds=[rootId||activeId].filter(Boolean);}
   renderSheets();
 }));
}
function filteredRows(d){
 const q=normalize(query);const rows=d.records.map((r,i)=>({r,i}));
 if(!q)return rows;
 return rows.filter(o=>o.r.some(v=>normalize(v).includes(q)));
}
function displayCell(v){return v===null||v===undefined?'':String(v);}
function selectedRowsFor(docId){return new Set(selectedRowsById[docId]||[]);}
function updateBulkToolbar(){
 const d=activeDoc(),selected=d?selectedRowsFor(d.id):new Set(),n=selected.size;
 $('#toggleSelectedNewBtn').disabled=!d||!n||findFieldIdx(d,'new')<0;
 $('#toggleSelectedUseBtn').disabled=!d||!n||findFieldIdx(d,'use')<0;
 $('#selectedCountNew').textContent=`${n} selected`;
 $('#selectionHint').textContent=d?(n?`${n} row${n===1?'':'s'} selected in ${baseNoExt(d.exportName||d.filename)}. Drag to extend; Ctrl-click or Shift-click also works.`:'Select rows with the mouse. Hold and drag to select a range.'):'Import a file to enable row selection.';
 $('#resetNewFlagsBtn').disabled=!docs.some(file=>findFieldIdx(file,'new')>=0&&file.records.some(row=>getVal(file,row,'new').trim()==='1'));
}
function paintSelection(docId){
 const card=$$('#sheetGrid [data-card]').find(el=>el.dataset.card===docId);if(!card)return;
 const selected=selectedRowsFor(docId),cell=selectedCellById[docId];
 $$('[data-select-row]',card).forEach(tr=>tr.classList.toggle('selected',selected.has(Number(tr.dataset.selectRow))));
 $$('[data-cell]',card).forEach(td=>td.classList.toggle('selected-cell',!!cell&&Number(td.dataset.cell)===cell.row&&Number(td.dataset.col)===cell.col));
 updateBulkToolbar();
}
function selectRowsFromPointer(d,index,event){
 activeId=d.id;selectedRowById[d.id]=index;
 const current=selectedRowsFor(d.id),anchor=selectionAnchorById[d.id];let next;
 if(event.shiftKey){const start=Number.isInteger(anchor)?anchor:index;const lo=Math.min(start,index),hi=Math.max(start,index);next=new Set();for(let r=lo;r<=hi;r++)next.add(r);}
 else if(event.ctrlKey||event.metaKey){next=new Set(current);if(next.has(index))next.delete(index);else next.add(index);selectionAnchorById[d.id]=index;}
 else{next=new Set([index]);selectionAnchorById[d.id]=index;}
 selectedRowsById[d.id]=[...next];
 renderHeadOnly();paintSelection(d.id);
}
function renderSheetCard(d,split=false){
 const results=filteredRows(d),all=viewMode==='all';
 const actualSize=all?Math.max(1,results.length):pageSize;
 const pages=Math.max(1,Math.ceil(results.length/actualSize));
 const page=all?0:Math.max(0,Math.min(pageById[d.id]||0,pages-1));pageById[d.id]=page;
 const slice=all?results:results.slice(page*actualSize,(page+1)*actualSize);const selected=selectedRowsFor(d.id),selectedCell=selectedCellById[d.id];
 const heads=d.headers.map((h,i)=>`<th scope="col" title="${esc(h)}">${esc(h||`Column ${i+1}`)}</th>`).join('');
 const rowsHtml=slice.map(({r,i})=>{const inactive=String(getVal(d,r,'use')).trim()==='0';const classes=[selected.has(i)?'selected':'',inactive?'inactive-row':''].filter(Boolean).join(' ');return `<tr data-select-row="${i}" tabindex="0" aria-selected="${selected.has(i)}" class="${classes}" ${inactive?'title="Inactive: Use = 0"':''}><td class="row-number">${i+3}</td>${r.map((v,j)=>{const selectedClass=selectedCell&&selectedCell.row===i&&selectedCell.col===j?' selected-cell':'';return `<td class="${selectedClass.trim()}" data-cell="${i}" data-col="${j}" title="Click to select; double-click or press F2 to edit"><span class="cell-text">${esc(displayCell(v))}</span></td>`;}).join('')}</tr>`}).join('');
 const pager=all?'':`<div class="pager"><button type="button" data-page="prev" data-page-size="${pageSize}" data-doc="${d.id}" ${page<=0?'disabled':''} aria-label="Previous page" title="Previous page">‹</button><span class="page-count">${page+1} / ${pages}</span><button type="button" data-page="next" data-page-size="${pageSize}" data-doc="${d.id}" ${page>=pages-1?'disabled':''} aria-label="Next page" title="Next page">›</button><button type="button" class="pager-last" data-page="last" data-page-size="${pageSize}" data-doc="${d.id}" ${page>=pages-1?'disabled':''} title="Go to last page">Last page ↠</button></div>`;
 const rangeText=all?`Showing all ${results.length.toLocaleString('en-US')} results · scroll to browse`:results.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,results.length)} of ${results.length.toLocaleString('en-US')}`:'0 results';
 return `<article class="sheet-card" data-card="${d.id}">
  <div class="sheet-card-head"><div class="sheet-card-title">${isRoot(d)?'<span class="tab-root"></span>':''}<span class="sheet-name">${esc(baseNoExt(d.exportName||d.filename))}</span><span class="sheet-card-sub">${d.records.length.toLocaleString('en-US')} rows</span></div>${split?`<span class="badge ${isRoot(d)?'root':''}">${isRoot(d)?'ROOT':'VIEW'}</span>`:`<span class="sheet-card-sub">Select a cell · F2 or double-click to edit</span>`}</div>
  <div class="table-scroll ${all?'table-scroll-all':''}"><table><thead><tr><th scope="col">#</th>${heads}</tr></thead><tbody>${rowsHtml||`<tr><td colspan="${d.headers.length+1}"><div class="empty-state">${query?'No rows match your search.':'No rows in this file yet.'}</div></td></tr>`}</tbody></table></div>
  <div class="table-footer"><div class="pager-left">${rangeText}${selected.size?` · ${selected.size} selected`:''}${selectedRowById[d.id]!==undefined?` · anchor row ${selectedRowById[d.id]+3}`:''}</div>${pager}</div>
 </article>`;
}
function renderSheets(){
 const grid=$('#sheetGrid'),area=$('.sheet-area'),d=activeDoc();let showDocs=[];
 if(!splitMode){if(d)showDocs=[d];}
 else{viewIds=viewIds.filter((id,i,a)=>docById(id)&&a.indexOf(id)===i).slice(0,3);if(!viewIds.length&&d)viewIds=[d.id];showDocs=viewIds.map(docById).filter(Boolean);}
 grid.className='sheet-grid'+(splitMode&&showDocs.length===2?' split-2':splitMode&&showDocs.length>=3?' split-3':'')+(viewMode==='all'?' all-rows':'');
 area.classList.toggle('all-rows-mode',viewMode==='all');
 grid.innerHTML=showDocs.length?showDocs.map(doc=>renderSheetCard(doc,splitMode)).join(''):`<article class="sheet-card"><div class="empty-state"><div class="empty-logo">P</div><strong>No files in this workspace</strong><br>Import your .slk files to create the first register.</div></article>`;
 $$('#sheetGrid [data-page]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.doc;const d=docById(id);if(!d)return;const pages=Math.max(1,Math.ceil(filteredRows(d).length/pageSize));if(b.dataset.page==='last')pageById[id]=pages-1;else pageById[id]=Math.max(0,Math.min(pages-1,(pageById[id]||0)+(b.dataset.page==='next'?1:-1)));renderSheets();}));
 $$('#sheetGrid [data-select-row]').forEach(tr=>{
  tr.addEventListener('mousedown',e=>{if(e.button!==0||e.target.closest('input,button,a'))return;const card=tr.closest('[data-card]'),file=docById(card.dataset.card),index=Number(tr.dataset.selectRow);if(!file)return;const cell=e.target.closest('[data-cell]');if(cell)selectedCellById[file.id]={row:Number(cell.dataset.cell),col:Number(cell.dataset.col)};
   if(dragSelectEnabled&&!e.ctrlKey&&!e.metaKey){const anchor=e.shiftKey&&Number.isInteger(selectionAnchorById[file.id])?selectionAnchorById[file.id]:index;if(!e.shiftKey)selectionAnchorById[file.id]=index;dragSelection={docId:file.id,anchor,base:[],mode:'range'};const lo=Math.min(anchor,index),hi=Math.max(anchor,index),set=[];for(let i=lo;i<=hi;i++)set.push(i);selectedRowsById[file.id]=set;selectedRowById[file.id]=index;activeId=file.id;renderHeadOnly();paintSelection(file.id);}
   else if(!dragSelectEnabled){selectRowsFromPointer(file,index,e);}
   else{selectRowsFromPointer(file,index,e);}
   e.preventDefault();
  });
  tr.addEventListener('mouseover',()=>{if(!dragSelectEnabled||!dragSelection||dragSelection.docId!==tr.closest('[data-card]').dataset.card)return;const index=Number(tr.dataset.selectRow),lo=Math.min(dragSelection.anchor,index),hi=Math.max(dragSelection.anchor,index),set=[];for(let i=lo;i<=hi;i++)set.push(i);selectedRowsById[dragSelection.docId]=set;selectedRowById[dragSelection.docId]=index;paintSelection(dragSelection.docId);});
  tr.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('[data-cell] input')){e.preventDefault();const card=tr.closest('[data-card]'),file=docById(card.dataset.card);if(file)selectRowsFromPointer(file,Number(tr.dataset.selectRow),e);}});
 });
 $$('#sheetGrid [data-cell]').forEach(td=>{
  td.addEventListener('click',()=>{const card=td.closest('[data-card]'),file=docById(card.dataset.card);if(!file)return;selectedCellById[file.id]={row:Number(td.dataset.cell),col:Number(td.dataset.col)};activeId=file.id;paintSelection(file.id);});
  td.addEventListener('dblclick',()=>{if(td.querySelector('input'))return;const card=td.closest('[data-card]'),file=docById(card.dataset.card);if(file){selectedCellById[file.id]={row:Number(td.dataset.cell),col:Number(td.dataset.col)};activeId=file.id;beginCellEdit(td);}});
 });
 $('#resultCount').textContent=query?`${filteredRows(activeDoc()||{records:[]}).length.toLocaleString('en-US')} matches`:`${(activeDoc()?.records.length||0).toLocaleString('en-US')} records`;
 updateBulkToolbar();
}
function renderHeadOnly(){updateHead();renderSidebar();renderTabs();updateBulkToolbar();}
function beginCellEdit(td){
 if(td.querySelector('input'))return;
 const card=td.closest('[data-card]'),d=docById(card.dataset.card);if(!d)return;
 const rowIndex=Number(td.dataset.cell),colIndex=Number(td.dataset.col),old=String(d.records[rowIndex]?.[colIndex]??'');
 const input=document.createElement('input');input.className='cell-input';input.value=old;input.setAttribute('aria-label',`Edit ${d.headers[colIndex]||`column ${colIndex+1}`}, row ${rowIndex+3}`);
 const type=normalize(d.types[colIndex]||'string');input.type=(type==='int'||type==='float')?'number':'text';if(type==='float')input.step='any';if(type==='int')input.step='1';
 td.replaceChildren(input);input.focus();input.select();let finished=false;
 const finish=(save)=>{if(finished)return;finished=true;const v=input.value;if(save&&v!==old){d.records[rowIndex][colIndex]=v;markDirty(d);selectedRowById[d.id]=rowIndex;selectedCellById[d.id]={row:rowIndex,col:colIndex};toast(`Updated ${d.headers[colIndex]} in ${baseNoExt(d.exportName)}.`);renderAll();}else{renderSheets();}};
 input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish(true);}if(e.key==='Escape'){e.preventDefault();finish(false);}});input.addEventListener('blur',()=>finish(true));
}
function toggleSelectedField(field){
 const d=activeDoc();if(!d){toast('Import a file first.','error');return;}
 const index=findFieldIdx(d,field),selected=selectedRowsFor(d.id);if(index<0){toast(`${field.toUpperCase()} is not available in this file.`,'error');return;}
 if(!selected.size){toast('Select one or more rows first.','error');return;}
 let changed=0;for(const rowIndex of selected){const row=d.records[rowIndex];if(!row)continue;row[index]=String(row[index]??'').trim()==='1'?'0':'1';changed++;}
 if(changed){markDirty(d);renderAll();toast(`${field.toUpperCase()} toggled for ${changed} selected row${changed===1?'':'s'}.`);}
}
function resetNewFlags(){
 let changed=0,filesChanged=0;
 for(const d of docs){const index=findFieldIdx(d,'new');if(index<0)continue;let local=0;for(const row of d.records){if(String(row[index]??'').trim()==='1'){row[index]='0';local++;}}
  if(local){markDirty(d);changed+=local;filesChanged++;}}
 if(!changed){toast('No NEW = 1 values found in the loaded files.');return;}
 renderAll();toast(`Set NEW = 0 for ${changed} row${changed===1?'':'s'} across ${filesChanged} file${filesChanged===1?'':'s'}.`);
}
function renderCoverage(){
 const root=docById(rootId);if(!root){const old=$('#rootCoverage');if(old)old.remove();return;}
 const base=new Set(root.records.map(r=>identity(root,r)));let missing=0;
 for(const d of docs){if(d.id===rootId)continue;for(const row of d.records){if(!base.has(identity(d,row)))missing++;}}
 let box=$('#rootCoverage');
 if(!box){box=document.createElement('div');box.id='rootCoverage';box.className='coverage';$('.sidebar-actions').before(box);}
 box.innerHTML=`<div class="coverage-top"><span>Root coverage</span><span class="coverage-count">${missing?`${missing.toLocaleString('en-US')} missing`:'In sync'}</span></div><p>${missing?'Some entries in the target lists do not exist in Root yet. Merging maps shared fields and initializes Root-only fields with safe defaults.':'Every target entry is represented in Root by artist, title and file name.'}</p><button type="button" class="btn ${missing?'btn-primary':''}" id="mergeRootBtn" ${missing?'':'disabled'}>${missing?'Add missing entries to Root':'All entries covered'}</button>`;
 $('#mergeRootBtn').addEventListener('click',mergeMissingIntoRoot);
}
function renderAll(){renderSidebar();renderTabs();updateHead();renderSplitChooser();renderSyncFields();renderSheets();renderCoverage();updateBulkToolbar();}
function renderAllAfterEdit(){renderAll();}
function openModal(){
 const d=docById(rootId);if(!d){toast('Import a file and select one Root first.','error');return;}
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
 const root=docById(rootId);if(!root)return;
 const targets=targetDocs().filter(t=>findFieldIdx(t,'level')>=0);
 const filenameIndex=findFieldIdx(root,'filename'),newIndex=findFieldIdx(root,'new'),useIndex=findFieldIdx(root,'use');
 $('#entryList').innerHTML=entryDrafts.map((row,entryIndex)=>{
  const fields=root.headers.map((head,col)=>{
   const type=normalize(root.types[col]||'string'),numeric=type==='int'||type==='float';let value=row[col]??'';
   if(col===newIndex||col===useIndex)value='1';
   const readonly=(col===newIndex||col===useIndex)?' readonly aria-readonly="true" title="New entries always use 1 for this field"':'';
   const step=type==='int'?'1':type==='float'?'any':null;
   const helper=(col===filenameIndex)?'<span class="field-helper">Auto-generated; editable</span>':((col===newIndex||col===useIndex)?'<span class="field-helper">Always 1 for new entries</span>':'');
   return `<div class="field"><label for="entry_${entryIndex}_${col}">${esc(head||`Column ${col+1}`)}${numeric?` <span class="type-tag">${esc(type)}</span>`:''}</label><input id="entry_${entryIndex}_${col}" data-entry-index="${entryIndex}" data-add-col="${col}" type="${numeric?'number':'text'}" ${step?`step="${step}"`:''} value="${esc(value)}"${readonly}${[findFieldIdx(root,'singer'),findFieldIdx(root,'title'),filenameIndex].includes(col)?' required':''}>${helper}</div>`;
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
 const root=docById(rootId);if(!root)return;collectEntryDrafts();
 const previous=entryDrafts[entryDrafts.length-1]||newEntrySeed(root,nextTbmFilename(root,prefixValue(),0));
 const next=previous.slice(),prefix=prefixValue(),filenameIndex=findFieldIdx(root,'filename'),offsetIndex=findFieldIdx(root,'offset'),newIndex=findFieldIdx(root,'new'),useIndex=findFieldIdx(root,'use');
 if(filenameIndex>=0)next[filenameIndex]=incrementTbmFilename(previous[filenameIndex],prefix,root,0);
 if(offsetIndex>=0)next[offsetIndex]='0.7';if(newIndex>=0)next[newIndex]='1';if(useIndex>=0)next[useIndex]='1';
 entryDrafts.push(next);entryTargetLevels.push({...entryTargetLevels[entryTargetLevels.length-1]});
 renderEntryDrafts();const latest=$$('#entryList [data-entry-card]').at(-1);if(latest){latest.scrollIntoView({behavior:'smooth',block:'start'});const first=latest.querySelector('input:not([readonly])');if(first)first.focus({preventScroll:true});}
}
function addEntryFromForm(event){
 event.preventDefault();const source=docById(rootId);if(!source)return;collectEntryDrafts();
 if(!entryDrafts.length){toast('Add at least one entry first.','error');return;}
 const requiredFields=['singer','title','filename'],seenNames=new Set();
 for(let n=0;n<entryDrafts.length;n++){
  const row=entryDrafts[n];
  for(const field of requiredFields){const col=findFieldIdx(source,field);if(col>=0&&!String(row[col]??'').trim()){toast(`Entry ${n+1}: please complete ${source.headers[col]}.`,'error');return;}}
  const fn=String(row[findFieldIdx(source,'filename')]??'').trim().toLocaleLowerCase();if(fn&&seenNames.has(fn)){toast(`The file name ${fn} is repeated. Each new entry needs its own TBM filename.`,'error');return;}if(fn)seenNames.add(fn);
 }
 let targetsAdded=0,targetsUpdated=0;
 const targets=targetDocs();
 for(let n=0;n<entryDrafts.length;n++){
  const row=[...entryDrafts[n]];const newIndex=findFieldIdx(source,'new'),useIndex=findFieldIdx(source,'use');if(newIndex>=0)row[newIndex]='1';if(useIndex>=0)row[useIndex]='1';
  source.records.push(row);
  for(const target of targets){const level=entryTargetLevels[n]?.[target.id]??target.targetLevel??'3';const result=upsertToTarget(source,row,target,level);if(result==='added')targetsAdded++;else if(result==='updated')targetsUpdated++;}
 }
 const lastIndex=source.records.length-1;markDirty(source);selectedRowById[source.id]=lastIndex;selectedRowsById[source.id]=[lastIndex];selectedCellById[source.id]=null;selectionAnchorById[source.id]=lastIndex;pageById[source.id]=viewMode==='all'?0:Math.max(0,Math.ceil(filteredRows(source).length/pageSize)-1);
 closeModal();activeId=source.id;splitMode=false;$('#splitToggle').checked=false;renderAll();
 toast(`${entryDrafts.length} entr${entryDrafts.length===1?'y':'ies'} added at the end of Root.${targetsAdded?` ${targetsAdded} target entr${targetsAdded===1?'y':'ies'} added.`:''}${targetsUpdated?` ${targetsUpdated} target entr${targetsUpdated===1?'y':'ies'} updated.`:''}`);
 entryDrafts=[];entryTargetLevels=[];
}
function closeModal(){$('#entryModal').classList.remove('visible');}
function syncSelected(){
 const source=docById(rootId);if(!source){toast('Select a Root file first.','error');return;}
 if(!syncFieldKeys.size){toast('Select at least one field in Selective sync first.','error');return;}
 if(activeId!==rootId){toast('Open the Root tab and select the row you want to apply.','error');return;}
 const idx=selectedRowById[rootId];if(idx===undefined||!source.records[idx]){toast('Select a row in Root first.','error');return;}
 const targets=targetDocs();if(!targets.length){toast('Select at least one Target file in the left panel.','error');return;}
 let added=0,updated=0;for(const t of targets){const s=upsertToTarget(source,source.records[idx],t);if(s==='added')added++;else if(s==='updated')updated++;}
 renderAll();toast(`Selected fields applied. ${added} target entr${added===1?'y':'ies'} added, ${updated} updated.`);
}
function mergeMissingIntoRoot(){
 const root=docById(rootId);if(!root)return;
 const seen=new Set(root.records.map(r=>identity(root,r))),pending=[];
 for(const source of docs){if(source.id===rootId)continue;for(const r of source.records){const key=identity(source,r);if(seen.has(key))continue;seen.add(key);pending.push({source,row:r});}}
 if(!pending.length){toast('Root already covers all target entries.');return;}
 if(!confirm(`Add ${pending.length} missing entr${pending.length===1?'y':'ies'} to ${root.filename}?

Root-only fields (including MADI fields and metadata) will be initialized with defaults. Review these rows before exporting.`))return;
 for(const item of pending)root.records.push(mapRow(item.source,item.row,root,null));
 markDirty(root);selectedRowById[root.id]=root.records.length-1;pageById[root.id]=viewMode==='all'?0:Math.max(0,Math.ceil(root.records.length/pageSize)-1);activeId=root.id;renderAll();toast(`${pending.length} missing entr${pending.length===1?'y':'ies'} merged into Root. Review Root-only MADI and metadata fields before exporting.`);
}
function setSplitMode(on){splitMode=on;if(on){const initial=[rootId,activeId,...docs.filter(d=>d.syncTarget).map(d=>d.id)].filter((v,i,a)=>v&&a.indexOf(v)===i);viewIds=initial.slice(0,3);if(!viewIds.length&&docs.length)viewIds=[docs[0].id];}renderSplitChooser();renderSheets();}
function localDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function exportCurrent(){const d=activeDoc();if(!d)return;try{const bytes=serializeDoc(d);downloadBytes(bytes,d.exportName||d.filename);dirty.delete(d.id);renderAll();toast(`${d.exportName||d.filename} exported.`);}catch(e){toast(e.message,'error');}}
async function exportZip(){if(!docs.length)return;const date=localDate(),folder=`${date}_pochita_export`;try{
 if(typeof JSZip==='undefined')throw new Error('ZIP support could not load. Refresh the page and try again.');
 const zip=new JSZip(),inner=zip.folder(folder),used=new Set();
 for(const d of docs){let name=safeSlkName(d.exportName||d.filename),base=name,number=2;while(used.has(name.toLocaleLowerCase())){name=`${baseNoExt(base)}_${number++}.slk`;}used.add(name.toLocaleLowerCase());inner.file(name,serializeDoc(d));}
 const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});downloadBytes(blob,`${folder}.zip`,'application/zip');dirty.clear();renderAll();toast(`ZIP downloaded: ${folder}.zip`);
 }catch(e){toast(e.message,'error');}}
function safeSlkName(name){let safe=basename(String(name||'export.slk')).replace(/[\/]/g,'_').trim().replace(/^\.+|\.+$/g,'');if(!safe)safe='export.slk';if(!safe.toLowerCase().endsWith('.slk'))safe+='.slk';return safe;}
async function importFiles(fileList){
 const files=[...fileList].filter(f=>f.name.toLowerCase().endsWith('.slk')||f.name.toLowerCase().endsWith('.txt'));
 if(!files.length){toast('Choose one or more .slk files.','error');return;}
 try{updateStatus(`Reading ${files.length} file${files.length===1?'':'s'}…`);const addedDocs=[];
  for(const f of files){const d=parseSlk(f.name,new Uint8Array(await f.arrayBuffer()));const existing=docs.find(x=>normalize(x.filename)===normalize(d.filename));if(existing){d.filename=`${baseNoExt(d.filename)}_copy.slk`;d.exportName=d.filename;}d.targetLevel='3';d.syncTarget=true;docs.push(d);addedDocs.push(d);pageById[d.id]=0;}
  if(!rootId&&docs.length){rootId=docs.reduce((a,b)=>b.records.length>a.records.length?b:a).id;docById(rootId).syncTarget=false;if(!activeId)activeId=rootId;}
  if(addedDocs.length===1)activeId=addedDocs[0].id;else if(!activeId&&docs.length)activeId=rootId||docs[docs.length-1].id;
  if(!viewIds.length)viewIds=docs.slice(0,3).map(d=>d.id);updateStatus('Files imported');renderAll();toast(`${addedDocs.length} file${addedDocs.length===1?'':'s'} imported successfully.`);
 }catch(e){updateStatus('Import failed');toast(e.message,'error');}$('#filePicker').value='';
}
function clearWorkspace(){
 if(!docs.length)return;
 if(!confirm('Remove all files from this workspace? Exported files on your computer will not be changed. Unsaved edits in this session will be discarded.'))return;
 docs=[];activeId=null;rootId=null;splitMode=false;viewIds=[];query='';pageById={};selectedRowById={};selectedRowsById={};selectedCellById={};selectionAnchorById={};dirty.clear();syncFieldKeys.clear();$('#searchInput').value='';$('#splitToggle').checked=false;renderAll();updateStatus('Workspace cleared. Import your SLK files to continue.');toast('Workspace cleared. Your original files on disk were not changed.');
}
$('#selectAllSyncFields').addEventListener('click',()=>{syncFieldKeys=new Set(syncFieldOptions().map(f=>f.key));renderSyncFields();updateHead();});
$('#clearSyncFields').addEventListener('click',()=>{syncFieldKeys.clear();renderSyncFields();updateHead();});
$('#addFilesBtn').addEventListener('click',()=>$('#filePicker').click());
$('#filePicker').addEventListener('change',event=>importFiles(event.target.files));
$('#resetDemoBtn').addEventListener('click',clearWorkspace);
$('#newEntryBtn').addEventListener('click',openModal);
$('#syncBtn').addEventListener('click',syncSelected);
$('#exportCurrentBtn').addEventListener('click',exportCurrent);
$('#exportZipBtn').addEventListener('click',exportZip);
$('#searchInput').addEventListener('input',event=>{query=event.target.value;docs.forEach(d=>pageById[d.id]=0);renderSheets();});
$('#rowLimit').addEventListener('change',event=>{const value=event.target.value;viewMode=value==='all'?'all':'paged';if(viewMode==='paged')pageSize=Math.max(1,Math.min(100,Number(value)||100));docs.forEach(d=>pageById[d.id]=0);renderSheets();});
$('#splitToggle').addEventListener('change',event=>setSplitMode(event.target.checked));
$('#resetNewFlagsBtn').addEventListener('click',resetNewFlags);
$('#toggleSelectedNewBtn').addEventListener('click',()=>toggleSelectedField('new'));
$('#toggleSelectedUseBtn').addEventListener('click',()=>toggleSelectedField('use'));
$('#f2Enabled').addEventListener('change',event=>{f2Enabled=event.target.checked;});
$('#dragSelectEnabled').addEventListener('change',event=>{dragSelectEnabled=event.target.checked;if(!dragSelectEnabled)dragSelection=null;});
$('#addAnotherEntry').addEventListener('click',addAnotherDraft);
$('#tbmPrefixSelect').addEventListener('change',()=>{const custom=$('#tbmPrefixSelect').value==='__custom__';$('#customPrefixField').hidden=!custom;if(custom){$('#tbmCustomPrefix').focus();}else{recalculateEntryFilenames();}});
$('#tbmCustomPrefix').addEventListener('change',recalculateEntryFilenames);
$('#modalClose').addEventListener('click',closeModal);
$('#cancelEntryBtn').addEventListener('click',closeModal);
$('#entryModal').addEventListener('click',event=>{if(event.target===$('#entryModal'))closeModal();});
$('#entryForm').addEventListener('submit',addEntryFromForm);
document.addEventListener('mouseup',()=>{dragSelection=null;});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape')closeModal();
 if(event.key==='F2'&&f2Enabled&&!$('#entryModal').classList.contains('visible')&&!event.target.closest('input,textarea,select,button')){
  event.preventDefault();const d=activeDoc(),cell=d&&selectedCellById[d.id];if(!d||!cell)return;const card=$$('#sheetGrid [data-card]').find(item=>item.dataset.card===d.id);const td=card?.querySelector(`td[data-cell="${cell.row}"][data-col="${cell.col}"]`);if(td)beginCellEdit(td);
 }
});
function setTheme(theme){
 const dark=theme==='dark';
 document.documentElement.dataset.theme=dark?'dark':'light';
 const button=$('#themeToggle'),label=$('#themeToggleLabel');
 if(button){button.setAttribute('aria-pressed',String(dark));button.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');button.title=dark?'Switch to light theme':'Switch to dark theme';}
 if(label)label.textContent=dark?'Light theme':'Dark theme';
 const meta=$('meta[name=theme-color]');if(meta)meta.setAttribute('content',dark?'#141923':'#202734');
 try{localStorage.setItem('pochita-theme',dark?'dark':'light');}catch(_){/* Private browsing may disable storage; theme still works for this session. */}
}
$('#themeToggle')?.addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
// Reflect the preference selected by theme-init.js without rewriting storage.
(function syncThemeButton(){
 const dark=document.documentElement.dataset.theme==='dark',button=$('#themeToggle'),label=$('#themeToggleLabel');
 if(button){button.setAttribute('aria-pressed',String(dark));button.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');button.title=dark?'Switch to light theme':'Switch to dark theme';}
 if(label)label.textContent=dark?'Light theme':'Dark theme';
})();

renderAll();updateStatus('Import one or more SLK files to get started.');
