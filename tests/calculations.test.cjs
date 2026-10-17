const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../shared/logic.js');
test('shared module is identical in backend/browser',()=>{assert.equal(fs.readFileSync('shared/logic.js','utf8'),fs.readFileSync('dist/logic.js','utf8'));});
test('gearless has no slip and uses mm',()=>{const r=core.calculate('calculateSpeedSlip',{motorType:'Gearless',diameter:240,ratedRpm:168,roping:2});assert.equal(r.carSpeed,1.0556);assert.equal(r.slipFrequency,null);});
test('geared frequency and roping are correct',()=>{const r=core.calculate('calculateSpeedSlip',{motorType:'Geared',diameter:700,ratedRpm:1750,roping:2,gearA:61,gearB:2,frequency:60,poles:4});assert.equal(r.syncRpm,1800);assert.equal(r.slipFrequency,1.6667);});
test('registration validation and component shape',()=>{assert.throws(()=>core.registration('','bad','short'));assert.equal(core.registration('Team',' X@example.test ','12345678').email,'x@example.test');assert.throws(()=>core.component([0,1,'MR','2:1'],4));assert.equal(core.scalar('=IMPORTXML(1)'),"'=IMPORTXML(1)");});
test('record recomputes untrusted client results',()=>{const r=core.record({version:1,id:'test-record-1234',action:'calculateMotorPower',inputs:{ratedRpm:1465,torque:192},result:{motorPowerKW:999},createdAt:new Date().toISOString()});assert.equal(r.result.motorPowerKW,29.45);});
test('CSV injection and backend URL checks',()=>{assert.ok(core.csv([['=1+1']]).includes("'=1+1"));assert.ok(!core.backendURL('http://evil.test'));assert.ok(core.backendURL('https://script.google.com/macros/s/demo/exec'));});
test('Total Power retains the existing generator formula and values',()=>{
 const r=core.calculate('calculatePowerAndAVR',{motorPowerKW:3.9,k2:.95,k3:.95,brakePowerBothW:324,tubeLightQty:4,panelLightQty:0,spotLightQty:4,crossFlowFanQty:2,othersFixedW:500});
 assert.equal(r.totalPowerKW,4.6228);assert.equal(r.suggestGeneratorKVA,8.668);assert.equal(r.suggestAVRKVA,11.557);
});
test('component adapter preserves input and selected report mapping',()=>{const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('web/component-core.js','utf8'),c);const source=JSON.parse(fs.readFileSync('data/component-source.json','utf8'));const snap=c.componentSnapshot({headers:source.headers,records:source.records.map(r=>({sheetRow:r.id,values:r.values}))});assert.equal(snap.index.length,77);assert.equal(snap.componentDetails[3].inputs.capacity,450);assert.equal(snap.componentDetails[3].categories[0].items.find(i=>i.label==='Motor Power (kW)').value,'3.9');});
