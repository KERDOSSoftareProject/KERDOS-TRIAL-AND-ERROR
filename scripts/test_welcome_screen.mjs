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
    import {LandingGate,OrgGate} from './src/pages/AccessPages.jsx';
    import {TeamPanel} from './src/pages/TeamPanel.jsx';
    const text=node=>typeof node==='string'?node:(node.children||[]).map(text).join('');
    assert.equal(welcomeGreeting(new Date(2026,9,31,9,42)),'Good morning');
    assert.equal(welcomeGreeting(new Date(2026,9,31,14,42)),'Good afternoon');
    assert.equal(welcomeGreeting(new Date(2026,9,31,20,42)),'Good evening');
    assert.match(welcomeDate(new Date(2026,9,31,9,42)),/^Saturday · October 31 · /);
    assert.equal(userInitials("Hornet's Nest"),'HN');
    let destination=null,tree;
    await act(async()=>{tree=Renderer.create(React.createElement(WelcomeScreen,{clientName:'Hornets Nest',userName:'Casey Rivera',role:'owner',onNavigate:id=>destination=id,attentionCount:7,invoiceReviewCount:2,inboxCount:3}));});
    const buttons=tree.root.findAllByType('button');
    assert.deepEqual(buttons.map(text).map(s=>s.match(/Order Guide|Item Catalog|Price Sheets|Invoices|Inbox|Vendor Connect|Admin/)?.[0]),['Order Guide','Item Catalog','Price Sheets','Invoices','Inbox','Vendor Connect','Admin']);
    assert.match(text(tree.toJSON()),/Welcome Hornets Nest!Good (morning|afternoon|evening), Casey Rivera!/);
    assert.ok(!text(tree.toJSON()).includes("October"),"welcome screen does not show the date");
    assert.match(text(tree.toJSON()),/3 attachments need attention/);
    assert.equal(buttons[4].findAll(n=>n.props.className==='welcome-badge').length,1);
    await act(async()=>{buttons[2].props.onClick();});assert.equal(destination,'priceSheets');
    await act(async()=>{buttons[5].props.onClick();});assert.equal(destination,'vendorConnect');
    tree.unmount();
    await act(async()=>{tree=Renderer.create(React.createElement(WelcomeScreen,{role:'employee',onNavigate:id=>destination=id}));});
    assert.match(text(tree.toJSON()),/Welcome!Good (morning|afternoon|evening)!/);
    assert.equal(tree.root.findAllByType('button').length,4,'restricted sections must not be offered to employees');
    assert.ok(!text(tree.toJSON()).includes('unread'),'no invented unread count');
    tree.unmount();
    for(const role of ['owner','manager','employee']){
      let home=false;
      await act(async()=>{tree=Renderer.create(React.createElement(TabHeading,{title:'Price Sheets',activeTab:'priceSheets',role,onHome:()=>home=true,onNavigate:id=>destination=id}));});
      const navButtons=tree.root.findAllByType('button');
      assert.equal(navButtons.length,role==='employee'?5:8);
      assert.equal(navButtons.filter(b=>b.props['aria-current']==='page').length,1);
      await act(async()=>{navButtons[0].props.onClick();});assert.equal(home,true);
      const expected=role==='employee'?['order','catalog','priceSheets','invoices']:['order','catalog','priceSheets','invoices','inbox','vendorConnect','team'];
      for(let i=0;i<expected.length;i++){await act(async()=>{navButtons[i+1].props.onClick();});assert.equal(destination,expected[i]);}
      tree.unmount();
    }
    console.log('PASS tab navigation destinations, Home callback, active page and role restrictions');
    console.log('PASS welcome greeting, local clock, six routes, real counts and access boundary');
    let company;
    await act(async()=>{tree=Renderer.create(React.createElement(OrgGate,{user:{id:'owner-2'},onComplete:created=>{company=created;}}));});
    const click=label=>act(async()=>tree.root.findAllByType('button').find(button=>text(button)===label).props.onClick());
    const enter=(input,value)=>act(async()=>input.props.onChange({target:{value}}));
    await click('Create a new organization');
    const industrySelect=tree.root.findByProps({id:'setup-industry'});
    assert.equal(industrySelect.type,'select');
    assert.equal(industrySelect.props.required,true);
    assert.deepEqual(industrySelect.findAllByType('option').map(option=>option.props.value),['','Restaurant']);
    assert.match(text(tree.toJSON()),/vocabulary.*automatically/);
    await enter(tree.root.findByProps({placeholder:"Your organization's name"}),'Second Company');
    assert.equal(tree.root.findAllByType('button').find(button=>text(button)==='Next →').props.disabled,true);
    await enter(tree.root.findByProps({id:'setup-industry'}),'Restaurant');
    await click('Next →');
    await enter(tree.root.findByProps({placeholder:'Vendor name'}),'Supply House');
    await click('Get Started →');
    assert.deepEqual(company,{id:'second-company',name:'Second Company',industry:'Restaurant',vendors:[{name:'Supply House',delivery_minimum_dollar:null,delivery_minimum_units:null}]});
    await act(async()=>tree.unmount());
    console.log('PASS company setup requires a listed industry and automatically supplies its vocabulary');
    const savedDraft=JSON.stringify({step:2,orgName:'Older Draft',industry:'Unlisted Industry',vendors:[{name:'Saved Vendor',minDollar:'',minUnits:''}]});
    globalThis.localStorage={getItem:()=>savedDraft,setItem(){},removeItem(){}};
    company=undefined;
    await act(async()=>{tree=Renderer.create(React.createElement(OrgGate,{user:{id:'older-draft'},onComplete:created=>{company=created;}}));});
    await click('Create a new organization');
    assert.equal(tree.root.findByProps({id:'setup-industry'}).props.value,'');
    assert.equal(tree.root.findAllByType('button').find(button=>text(button)==='Next →').props.disabled,true);
    assert.equal(company,undefined);
    await enter(tree.root.findByProps({id:'setup-industry'}),'Restaurant');
    await click('Next →');
    assert.equal(tree.root.findByProps({placeholder:'Vendor name'}).props.value,'Saved Vendor');
    await act(async()=>tree.unmount());
    delete globalThis.localStorage;
    console.log('PASS older setup drafts require a valid industry while retaining entered company and vendor details');
    let refreshed=false;
    await act(async()=>{tree=Renderer.create(React.createElement(TeamPanel,{orgId:'company',orgName:'Example',orgIndustry:'Older Unlisted Industry',orgSettings:{},categories:[],myRole:'owner',currentUserId:'owner',onOrgUpdated:()=>{refreshed=true;}}));});
    await act(async()=>{tree.root.findByProps({'aria-label':'Change industry'}).props.onClick();});
    const companyIndustry=tree.root.findByProps({id:'company-industry'});
    assert.equal(companyIndustry.type,'select');
    assert.equal(companyIndustry.props.value,'');
    assert.equal(tree.root.findAllByType('button').find(button=>text(button)==='Save').props.disabled,true);
    await enter(companyIndustry,'Restaurant');
    const categoryCheckbox=tree.root.findAllByType('input').find(input=>input.props.type==='checkbox');
    await act(async()=>{categoryCheckbox.props.onChange({target:{checked:false}});});
    assert.match(text(tree.toJSON()),/vocabulary.*automatically/);
    await click('Save');
    assert.equal(refreshed,true);
    assert.deepEqual(globalThis.__industryUpdates.at(-1),{industry:'Restaurant'});
    await act(async()=>tree.unmount());
    console.log('PASS company settings require a listed industry and keep vocabulary automatic when starter categories are optional');

    let keydown;
    globalThis.document={
      addEventListener:(name,listener)=>{assert.equal(name,'keydown');keydown=listener;},
      removeEventListener:(name,listener)=>{assert.equal(name,'keydown');assert.equal(listener,keydown);keydown=null;},
    };
    const inputs=()=>tree.root.findAllByType('input');
    const activateEmail=isTrusted=>tree.root.findByProps({'aria-label':'Email'}).parent.props.onClickCapture({nativeEvent:{isTrusted}});
    await act(async()=>{tree=Renderer.create(React.createElement(LandingGate));});
    assert.ok(inputs().every(input=>input.props.inert===''&&!input.props.autoFocus&&!input.props.readOnly));
    assert.deepEqual(inputs().map(input=>input.props.autoComplete),['username','current-password']);
    await act(async()=>activateEmail(false));
    assert.ok(inputs().every(input=>input.props.inert===''));
    await act(async()=>activateEmail(true));
    assert.ok(inputs().every(input=>input.props.inert===undefined));
    assert.equal(keydown,null);
    await click('Sign Up');
    assert.equal(inputs()[1].props.autoComplete,'new-password');
    await act(async()=>tree.unmount());
    await act(async()=>{tree=Renderer.create(React.createElement(LandingGate));});
    assert.ok(inputs().every(input=>input.props.inert===''));
    await act(async()=>keydown({key:'Tab',isTrusted:true}));
    assert.ok(inputs().every(input=>input.props.inert===undefined));
    await act(async()=>tree.unmount());
    assert.equal(keydown,null);
    delete globalThis.document;
    console.log('PASS sign-in keeps focus out until the first credential click or keyboard navigation, with native autofill hints');


  `,resolveDir:process.cwd(),sourcefile:'welcome-test.jsx',loader:'jsx'},bundle:true,platform:'node',format:'esm',jsx:'automatic',packages:'external',outfile,
    plugins:[{name:'setup-test-backend',setup(build){
      build.onResolve({filter:/backend\/index\.js$/},()=>({path:'setup-test-backend',namespace:'test'}));
      build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
        export const backend={
          records:{query:table=>{
            let update;
            const chain={
              select(){return chain;},eq(){return chain;},in(){return chain;},order(){return chain;},
              update(values){update=values;return chain;},
              then(resolve){
                if(update)(globalThis.__industryUpdates??=[]).push(update);
                resolve({data:['industry_templates','industry_vocabulary'].includes(table)?[{industry:'Restaurant'}]:[],error:null});
              },
            };
            return chain;
          }},
          organization:{create:async company=>({id:'second-company',...company})},
        };
      `}));
    }}]});
  execFileSync(process.execPath,[outfile],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
