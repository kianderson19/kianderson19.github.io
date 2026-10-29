(() => {
 const ids=["matchup","map","synergy","counter","statistics"], defaults=[6,7,5.5,4,5.5];
 const buttons=[...document.querySelectorAll('[data-score-preset]')];
 const fields=ids.map(id=>document.getElementById('v-'+id));
 const included=document.getElementById('include-statistics');
 const kind=document.getElementById('calc-kind');
 const output=document.getElementById('calc-result');
 const select=key=>buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scorePreset===key)));
 const bound=value=>Math.max(0,Math.min(10,value));
 // The same published weights and constants the engine uses (data/scoring-rules.json, generated at build time).
 let calibration=null, weights=null;
 function update(){
  fields[4].disabled=!included.checked;
  if(!calibration){output.textContent='보정 기준을 불러오는 중이에요.';return;}
  const active=(included.checked?fields:fields.slice(0,4)).map(field=>field.value===''?NaN:Number(field.value));
  if(active.some(value=>!Number.isFinite(value))){output.textContent='사용하는 항목에 숫자를 입력해 주세요.';return;}
  const reference=calibration[kind.value];
  const values=active.map((value,index)=>{const part=reference.parts[ids[index]];return bound(calibration.spread>0&&part.sd>0?5+calibration.spread*(bound(value)-part.mean)/part.sd:bound(value));});
  const denominator=weights.slice(0,values.length).reduce((sum,weight)=>sum+weight,0);
  const raw=values.reduce((sum,value,index)=>sum+value*weights[index],0)/denominator;
  const score=Math.round((5+(raw-5)*reference.expansion)*10)/10;
  output.replaceChildren(document.createTextNode('보정 항목 '+values.map(value=>value.toFixed(2)).join(' · ')+' → 가중 평균 '+raw.toFixed(6).replace(/\.?0+$/,'')+' · 분모 '+denominator+' · 공개 점수 '));
  const strong=document.createElement('strong');strong.textContent=score.toFixed(1);output.append(strong);
 }
 fields.forEach(field=>field.addEventListener('input',()=>{select(null);update();}));
 buttons.forEach(button=>button.addEventListener('click',()=>{let values;try{values=JSON.parse(button.dataset.scores);}catch{return;}
  if(!Array.isArray(values)||values.length!==5||values.slice(0,4).some(value=>typeof value!=='number'||!Number.isFinite(value)))return;
  fields.forEach((field,index)=>{field.value=values[index]===null?'':String(values[index]);});
  included.checked=button.dataset.hasStatistics==='true';kind.value='hero';select(button.dataset.scorePreset);update();
 }));
 included.addEventListener('change',()=>{select(null);update();});
 kind.addEventListener('change',()=>{select(null);update();});
 document.getElementById('reset-calculator').addEventListener('click',()=>{fields.forEach((field,index)=>{field.value=String(defaults[index]);});included.checked=true;kind.value='hero';select(null);update();});
 update();
 fetch('data/scoring-rules.json',{cache:'no-cache'}).then(response=>response.ok?response.json():Promise.reject(new Error(String(response.status))))
  .then(rules=>{if(!rules.calibration||!rules.calibration.hero||!rules.calibration.team||!rules.weights)throw new Error('calibration');weights=ids.map(id=>Number(rules.weights[id]));if(weights.some(weight=>!(weight>0)))throw new Error('weights');calibration=rules.calibration;update();})
  .catch(()=>{output.textContent='보정 기준을 불러오지 못했어요. 새로 고침해 주세요.';});
})();
