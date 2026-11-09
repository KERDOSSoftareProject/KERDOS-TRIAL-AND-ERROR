import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.a2-schedule-ui-'));
try{
 const outfile=join(dir,'ui.mjs');
 await build({stdin:{contents:`
 import React from 'react';
 import Renderer,{act} from 'react-test-renderer';
 import assert from 'node:assert/strict';
 import VendorSchedulePanel from './src/pages/VendorSchedulePanel.jsx';
 import {createVendorConnectService} from './src/services/vendor-connect.js';
 const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const request={id:'request-one',transfer_revision:1};
 let state={request_id:request.id,server_now:'2026-11-06T12:00:00Z',schedule:null,slots:[]};
 const writes=[];
 const backend={vendorConnect:{scheduleHistory:async()=>structuredClone(state),setSchedule:async input=>{
  writes.push(input);state={...state,schedule:{version:1,weekdays:input.weekdays,local_time:input.localTime+':00',timezone:input.timezone,enabled:input.enabled,grace_minutes:input.graceMinutes},slots:[{version:1,slot_at:'2026-11-05T11:00:00Z',state:'missed'}]};return 1;
 }}};
 const service=createVendorConnectService(backend);
 let tree;await act(async()=>{tree=Renderer.create(React.createElement(VendorSchedulePanel,{service,request}));});
 const button=()=>tree.root.findByType('button');
 assert.match(text(tree.toJSON()),/No scheduled times/);
 assert.equal(tree.root.findByProps({'aria-label':'Enable schedule'}).props.disabled,true);
 await act(async()=>{tree.root.findByProps({'aria-label':'Schedule local time'}).props.onChange({target:{value:'07:30'}});});
 await act(async()=>{await button().props.onClick();});
 assert.equal(writes.length,1);assert.equal(writes[0].expectedVersion,0);assert.equal(writes[0].enabled,false);
 assert.equal(writes[0].localTime,'07:30');assert.equal(writes[0].graceMinutes,15);
 assert.match(text(tree.toJSON()),/Missed/);assert.match(text(tree.toJSON()),/Version 1 · Off/);
 await act(async()=>{tree.root.findByProps({'aria-label':'Mon'}).props.onChange({target:{checked:false}});});
 await act(async()=>{await button().props.onClick();});assert.equal(writes.at(-1).expectedVersion,1);assert.ok(!writes.at(-1).weekdays.includes(1));
 state={...state,schedule:{...state.schedule,version:2,enabled:false},slots:[{version:1,slot_at:'2026-11-06T11:00:00Z',state:'verification_needed'}]};
 await act(async()=>{tree.update(React.createElement(VendorSchedulePanel,{service,request,resultKey:'paused'}));});
 assert.match(text(tree.toJSON()),/schedule was turned off/);
 assert.match(text(tree.toJSON()),/Once that works, enable the schedule/);
 state={...state,schedule:{...state.schedule,effective_to:'2026-11-06T12:00:00Z'}};
 await act(async()=>{tree.update(React.createElement(VendorSchedulePanel,{service,request,resultKey:'retired'}));});
 assert.doesNotMatch(text(tree.toJSON()),/schedule was turned off/,'a retired connection cannot show an old pause as current');
 state={...state,schedule:{...state.schedule,version:3,effective_to:null},slots:[...state.slots]};
 await act(async()=>{tree.update(React.createElement(VendorSchedulePanel,{service,request,resultKey:'later-off'}));});
 assert.doesNotMatch(text(tree.toJSON()),/schedule was turned off/,'an older sign-in stop cannot explain a later owner edit');
 await act(async()=>{tree.unmount();});
 console.log('PASS schedule controls: owner settings, versioned save, missed history, explicit disabled state before runner. No schedule enabled.');
 `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile});
 execFileSync(process.execPath,[outfile],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
