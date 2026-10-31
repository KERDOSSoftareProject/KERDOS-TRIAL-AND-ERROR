// Render the welcome view and exercise its navigation and role boundary.
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const dir=mkdtempSync(join(process.cwd(),'.welcome-test-'));
try{
  const outfile=join(dir,'run.mjs');
  await build({stdin:{contents:`
    import React from 'react';
    import Renderer,{act} from 'react-test-renderer';
    import assert from 'node:assert/strict';
    import TabHeading from './src/ui/TabHeading.jsx';
    import WelcomeScreen,{welcomeGreeting,welcomeDate,userInitials} from './src/pages/WelcomeScreen.jsx';
    const text=node=>typeof node==='string'?node:(node.children||[]).map(text).join('');
    assert.equal(welcomeGreeting(new Date(2026,9,31,9,42)),'Good morning');
    assert.equal(welcomeGreeting(new Date(2026,9,31,14,42)),'Good afternoon');
    assert.equal(welcomeGreeting(new Date(2026,9,31,20,42)),'Good evening');
    assert.match(welcomeDate(new Date(2026,9,31,9,42)),/^Saturday · October 31 · /);
    assert.equal(userInitials("Hornet's Nest"),'HN');
    let destination=null,tree;
    await act(async()=>{tree=Renderer.create(React.createElement(WelcomeScreen,{orgName:"Hornet's Nest",role:'owner',onNavigate:id=>destination=id,attentionCount:7,invoiceReviewCount:2,inboxCount:3}));});
    const buttons=tree.root.findAllByType('button');
    assert.deepEqual(buttons.map(text).map(s=>s.match(/Order Guide|Item Catalog|Price Sheets|Invoices|Inbox|Admin/)?.[0]),['Order Guide','Item Catalog','Price Sheets','Invoices','Inbox','Admin']);
    assert.match(text(tree.toJSON()),/Good (morning|afternoon|evening) Hornet's Nest!/);
    assert.ok(!text(tree.toJSON()).includes("October"),"welcome screen does not show the date");
    assert.match(text(tree.toJSON()),/3 attachments need attention/);
    assert.equal(buttons[4].findAll(n=>n.props.className==='welcome-badge').length,1);
    await act(async()=>{buttons[2].props.onClick();});assert.equal(destination,'priceSheets');
    tree.unmount();
    await act(async()=>{tree=Renderer.create(React.createElement(WelcomeScreen,{orgName:'Other Org',role:'employee',onNavigate:id=>destination=id}));});
    assert.equal(tree.root.findAllByType('button').length,4,'restricted sections must not be offered to employees');
    assert.ok(!text(tree.toJSON()).includes('unread'),'no invented unread count');
    tree.unmount();
    for(const role of ['owner','manager','employee']){
      let home=false;
      await act(async()=>{tree=Renderer.create(React.createElement(TabHeading,{title:'Price Sheets',activeTab:'priceSheets',role,onHome:()=>home=true,onNavigate:id=>destination=id}));});
      const navButtons=tree.root.findAllByType('button');
      assert.equal(navButtons.length,role==='employee'?5:7);
      assert.equal(navButtons.filter(b=>b.props['aria-current']==='page').length,1);
      await act(async()=>{navButtons[0].props.onClick();});assert.equal(home,true);
      const expected=role==='employee'?['order','catalog','priceSheets','invoices']:['order','catalog','priceSheets','invoices','inbox','team'];
      for(let i=0;i<expected.length;i++){await act(async()=>{navButtons[i+1].props.onClick();});assert.equal(destination,expected[i]);}
      tree.unmount();
    }
    console.log('PASS tab navigation destinations, Home callback, active page and role restrictions');
    console.log('PASS welcome greeting, local clock, six routes, real counts and access boundary');
  `,resolveDir:process.cwd(),sourcefile:'welcome-test.jsx',loader:'jsx'},bundle:true,platform:'node',format:'esm',jsx:'automatic',packages:'external',outfile});
  execFileSync(process.execPath,[outfile],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
