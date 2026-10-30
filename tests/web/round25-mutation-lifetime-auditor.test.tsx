// @vitest-environment jsdom
import React from 'react';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {App} from '../../apps/web/src/App.js';
import {api} from '../../apps/web/src/api.js';
import {CollabSocket,type HostFrame} from '@caw/collab-protocol';
import {buildApp} from '../../apps/server/src/app.js';
import {createMetadataStore} from '../../apps/server/src/store.js';
import {createAuthenticationService} from '../../apps/server/src/auth.js';
vi.mock('../../apps/web/src/api.js',()=>({api:Object.fromEntries(['getMe','getCapabilities','getRuntime','listProjects','listConversations','listNativeSessions','updateProject','getConversation','getAttachInstructions','getModels','getConversationLink','setConversationModel','getConversationHistory'].map(k=>[k,vi.fn()]))}));
vi.mock('../../apps/server/src/config.js',async original=>({...await original<any>(),findRepoRoot:()=>process.cwd()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const deferred=()=>{let resolve!:(v?:unknown)=>void;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
async function setup(){
 for(const fn of Object.values(api))if(vi.isMockFunction(fn))fn.mockReset();
 const dir=await mkdtemp(join(tmpdir(),'caw-r25-life-'));
 const store=createMetadataStore(dir);const project=await store.createProject({path:dir,label:'Original'});
 const conversation=await store.createConversation({projectId:project.id,title:'Chat'});
 await store.updateConversation(conversation.id,{modelPreference:'INITIAL_MODEL',ownership:'managed',state:'idle'});
 const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});await auth.initAuth();
 const config:any={host:'127.0.0.1',port:8791,stateDir:dir,allowedRoots:[dir],relayPort:8792,relayAllowedOrigins:[],maxActiveAgents:3,authTokenTtlHours:720,trustTailscaleOrigin:false,logLevel:'silent',insecureCookies:false};
 const app=buildApp({config,auth,store,originAllowlist:['https://workspace.test']});const session=auth.createSession();
 const headers={cookie:`__Host-caw_session=${session.token}`,origin:'https://workspace.test','x-caw-csrf':session.csrfToken};
 const request=async(method:'GET'|'PATCH',url:string,payload?:unknown)=>(await app.inject({method,url,headers,...(payload===undefined?{}:{payload:payload as any})})).json();
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:session.csrfToken}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{}} as any);
 vi.mocked(api.getRuntime).mockResolvedValue({ok:false,error:{code:'internal',message:'No runtime in this metadata test'}});
 vi.mocked(api.listProjects).mockImplementation(()=>request('GET','/api/projects'));
 vi.mocked(api.listConversations).mockImplementation(id=>request('GET',`/api/projects/${id}/conversations`));
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
 vi.mocked(api.getConversation).mockImplementation(id=>request('GET',`/api/conversations/${id}`));
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:false}} as any);
 vi.mocked(api.getModels).mockResolvedValue({ok:true,data:{models:[],source:'omp',reason:null}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:'ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',access:'full',instanceId:'host',generation:1}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:'not_found',message:'No history'}});
 const sockets:CollabSocket[]=[];
 vi.spyOn(CollabSocket.prototype,'connect').mockImplementation(function(this:CollabSocket){sockets.push(this);this.onOpen?.();});
 vi.spyOn(CollabSocket.prototype,'send').mockResolvedValue(true);
 const welcome:HostFrame={t:'welcome',proto:3,header:{type:'session',id:'native',cwd:dir,timestamp:''},state:{isStreaming:false,queuedMessageCount:0,cwd:dir,participants:[]},agents:[],entryCount:0};
 const openChat=async()=>{fireEvent.click(await screen.findByText('Original'));fireEvent.click(await screen.findByText('Chat'));await waitFor(()=>expect(sockets.length).toBeGreaterThan(0));await act(async()=>sockets.at(-1)!.onFrame?.(welcome,0));await screen.findByText('Preferred for next launch:');};
 return {store,project,conversation,request,sockets,welcome,openChat,teardown:async()=>{cleanup();await app.close();await rm(dir,{recursive:true,force:true});}};
}

it.each([false,true])('V25 rename ordering must survive leaving and reopening Projects (remount=%s)',async remount=>{
 const f=await setup();const gate=deferred();const writes:Promise<any>[]=[];
 let calls=0;
 vi.mocked(api.updateProject).mockImplementation((id,patch)=>{
  const p=(++calls===1?gate.promise:Promise.resolve()).then(()=>f.request('PATCH',`/api/projects/${id}`,patch));writes.push(p);return p;
 });
 try{
  render(<App/>);await screen.findByText('Original');
  fireEvent.click(screen.getByRole('button',{name:'Rename'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'First'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(calls).toBe(1));
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  if(remount){fireEvent.click(screen.getByTitle('Settings'));await screen.findByRole('button',{name:'← Back'});fireEvent.click(screen.getByRole('button',{name:'← Back'}));await screen.findByText('Original');}
  fireEvent.click(screen.getByRole('button',{name:'Rename'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'Final'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  // Over-specification removed: this asserted `Final` was persisted BEFORE the older
  // gated write was released — i.e. it froze the pre-fix parallel interleaving. That
  // state is mutually exclusive with per-entity serialization (the fix) and with the
  // remount=false control, where the second Save cannot even be issued until the first
  // settles. What the fix must guarantee is the FINAL value (line 67); here we only
  // assert the remount did not itself issue a write, so the older one is still the only
  // write in flight.
  if(remount)await waitFor(()=>expect(calls).toBe(1));
  await act(async()=>{gate.resolve();await writes[0];});
  await waitFor(()=>expect(calls).toBe(2));await act(async()=>{await Promise.all(writes);});
  const label=(await f.store.listProjects())[0]!.label;
  console.log('AUDIT25 rename lifetime',JSON.stringify({remount,label,calls}));
  expect(label).toBe('Final');
 }finally{await f.teardown();}
});

it.each([false,true])('V25 a delayed model save cannot override a later save after Back/reopen (remount=%s)',async remount=>{
 const f=await setup();const gate=deferred();const writes:Promise<any>[]=[];let calls=0;
 vi.mocked(api.setConversationModel).mockImplementation((id,model)=>{
  const p=(++calls===1?gate.promise:Promise.resolve()).then(()=>f.request('PATCH',`/api/conversations/${id}/model`,{model}));writes.push(p);return p;
 });
 try{
  render(<App/>);await f.openChat();fireEvent.click(screen.getByText('Conversation model settings'));
  fireEvent.change(screen.getByLabelText('Custom model ID'),{target:{value:'MODEL_FIRST'}});fireEvent.click(screen.getByRole('button',{name:'Save model'}));
  await waitFor(()=>expect(calls).toBe(1));
  if(remount){
   fireEvent.click(screen.getByTitle('Back'));fireEvent.click(await screen.findByText('Chat'));
   await waitFor(()=>expect(f.sockets).toHaveLength(2));await act(async()=>f.sockets.at(-1)!.onFrame?.(f.welcome,0));
   await waitFor(()=>expect((screen.getByLabelText('Custom model ID') as HTMLInputElement).value).toBe('INITIAL_MODEL'));
   fireEvent.click(screen.getByText('Conversation model settings'));
  }
  fireEvent.change(screen.getByLabelText('Custom model ID'),{target:{value:'MODEL_FINAL'}});
  if(remount){
   fireEvent.click(screen.getByRole('button',{name:'Save model'}));
   // Same over-specification as the rename case: the pre-gate read demanded the newer
   // model be persisted before the older gated save was released. The contract is the
   // final value (line 95), not the pre-fix parallel interleaving.
   await waitFor(()=>expect(calls).toBe(1));
  }
  await act(async()=>{gate.resolve();await writes[0];});
  if(!remount){await waitFor(()=>expect((screen.getByRole('button',{name:'Save model'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Save model'}));}
  await waitFor(()=>expect(calls).toBe(2));await act(async()=>{await Promise.all(writes);});
  const model=(await f.store.getConversation(f.conversation.id))!.modelPreference;
  console.log('AUDIT25 model write lifetime',JSON.stringify({remount,model,calls}));expect(model).toBe('MODEL_FINAL');
 }finally{await f.teardown();}
});
