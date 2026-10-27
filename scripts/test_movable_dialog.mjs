import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kerdos-dialog-'));
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {MovableDialog} from './src/ui/MovableDialog.jsx';
let tree;
globalThis.window={innerWidth:1000,innerHeight:700};
const point=()=>{
 const p=tree.root.findByProps({role:'dialog'});
 const [x,y]=p.props.style.transform.match(/-?[\d.]+/g).map(Number);
 return {x,y};
};
const rect=()=>{const {x,y}=point();return {left:200+x,right:800+x,top:150+y,bottom:550+y};};
act(()=>{tree=Renderer.create(<MovableDialog label="Test window"><div style={{padding:24}}><input defaultValue="Keep my draft"/><button>Save</button></div></MovableDialog>,{createNodeMock:element=>element.props.role==='dialog'?{getBoundingClientRect:rect}:null});});
const handle=tree.root.findByProps({'aria-label':'Move Test window'});
const target={setPointerCapture(){}};
act(()=>handle.props.onPointerDown({button:0,clientX:400,clientY:200,currentTarget:target,pointerId:1}));
act(()=>handle.props.onPointerMove({clientX:450,clientY:230}));
assert.deepEqual(point(),{x:50,y:30});
act(()=>handle.props.onPointerMove({clientX:10000,clientY:10000}));
assert.deepEqual(rect(),{left:384,right:984,top:284,bottom:684});
act(()=>handle.props.onPointerMove({clientX:-10000,clientY:-10000}));
assert.deepEqual(rect(),{left:16,right:616,top:16,bottom:416});
act(()=>handle.props.onPointerCancel());
const stopped=point();act(()=>handle.props.onPointerMove({clientX:500,clientY:500}));assert.deepEqual(point(),stopped);
act(()=>handle.props.onKeyDown({key:'Home',preventDefault(){}}));assert.deepEqual(point(),{x:0,y:0});
act(()=>handle.props.onKeyDown({key:'ArrowRight',preventDefault(){}}));assert.deepEqual(point(),{x:20,y:0});
assert.equal(tree.root.findByType('input').props.defaultValue,'Keep my draft');
assert.equal(tree.root.findByProps({role:'dialog'}).props.style.maxHeight,'calc(100dvh - 32px)');
const scroll=tree.root.findAllByType('div').find(x=>x.props.style?.overflowY==='auto');assert.ok(scroll);
console.log('PASS pointer and keyboard movement, both viewport edges, cancel, centering, draft retention and scroll container');
`;
try{const outfile=join(dir,'test.mjs');await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic'});process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8'}));}finally{rmSync(dir,{recursive:true,force:true});}
