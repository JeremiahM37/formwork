/** Exact transcription of explicitly identified resume-history rows. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else(root.__formwork=root.__formwork||{}).history=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 function dateParts(value){
  const s=String(value||'').trim();let m;
  if((m=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s)))return valid(+m[1],m[2]&&+m[2],m[3]&&+m[3]);
  if((m=/^(\d{1,2})\/(\d{4})$/.exec(s)))return valid(+m[2],+m[1]);
  if((m=/^([a-z]+)\s+(\d{4})$/i.exec(s))){const months=['january','february','march','april','may','june','july','august','september','october','november','december'];const name=m[1].toLowerCase();const month=months.findIndex(v=>v===name||v.slice(0,3)===name||(v==='september'&&name==='sept'))+1;return valid(+m[2],month);}
  return null;
 }
 function valid(year,month,day){if(year<1900||year>2100||month!=null&&(month<1||month>12)||day!=null&&(day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()))return null;return{year,month,day};}
 function formatDate(value,field){
  const p=dateParts(value);if(!p)return null;const pad=n=>String(n).padStart(2,'0');
  const hint=String(field.dateFormat||'').toUpperCase().replace(/\s+/g,'');
  if(field.type==='month'||hint==='YYYY-MM')return p.month?`${p.year}-${pad(p.month)}`:null;
  if(hint==='MM/YYYY')return p.month?`${pad(p.month)}/${p.year}`:null;
  if(hint==='YYYY'||/\byear\b/i.test(field.label||''))return String(p.year);
  if(field.type==='date'||hint==='YYYY-MM-DD')return p.month&&p.day?`${p.year}-${pad(p.month)}-${pad(p.day)}`:null;
  if(hint==='MM/DD/YYYY')return p.month&&p.day?`${pad(p.month)}/${pad(p.day)}/${p.year}`:null;
  // Unknown date widgets need inspection, not an invented day or guessed format.
  return null;
 }
 function answer(field,profile){
  const h=field.history;if(!h||!['education','experience','languages'].includes(h.kind))return null;
  const keys=h.kind==='languages'?['language','native','reading','speaking','writing','comprehension']:h.kind==='education'?['school','degree','field_of_study','start','end','summary','gpa']:['employer','title','industry','start','end','summary','current','location'];
  if(!keys.includes(h.key))return null;
  const records=profile[h.kind]||[];let index=h.index;
  const identityKeys=h.kind==='languages'?['language']:h.kind==='education'?['school','degree']:['employer','title'];
  const existing=identityKeys.filter(k=>norm(h.existing?.[k]));
  if(existing.length){const matches=records.map((r,i)=>({r,i})).filter(({r})=>existing.every(k=>norm(r[k])===norm(h.existing[k])));index=matches.length===1?matches[0].i:null;}
  const record=Number.isInteger(index)&&index>=0?records[index]:null;
  const path=`${h.kind}.${index??'unmatched'}.${h.key}`;
  if(!record)return{path,value:null};
  if(h.key==='start'||h.key==='end')return{path,value:h.key==='end'&&record.current===true?null:formatDate(record[h.key],field)};
  if(h.key==='summary')return{path,value:Array.isArray(record.bullets)&&record.bullets.length?record.bullets.join('\n'):null};
  if(h.key==='native')return{path,value:typeof record.native==='boolean'?String(record.native):null};
  if(h.key==='current')return{path,value:typeof record.current==='boolean'?String(record.current):null};
  return{path,value:record[h.key]??null};
 }
 return{answer,formatDate,dateParts};
});
