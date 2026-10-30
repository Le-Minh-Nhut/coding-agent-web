// @vitest-environment jsdom
import React from 'react';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {App} from '../../apps/web/src/App.js';
import {api,setCsrfToken} from '../../apps/web/src/api.js';
import {resetMutationQueues} from '../../apps/web/src/mutation-order.js';
import {resetProjectMutationState} from '../../apps/web/src/components/ProjectsView.js';
import {buildApp} from '../../apps/server/src/app.js';
import {createMetadataStore} from '../../apps/server/src/store.js';
import {createAuthenticationService} from '../../apps/server/src/auth.js';
vi.mock('../../apps/server/src/config.js',async original=>({...await original<any>(),findRepoRoot:()=>process.cwd()}));
afterEach(()=>{cleanup();setCsrfToken(null);resetMutationQueues();resetProjectMutationState();vi.restoreAllMocks();vi.unstubAllGlobals();});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {resolve,promise};};
it.each([false,true])('V26 queued model intent cannot replay under a new login (rotate=%s)',async rotate=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r26-auth-'));
 const store=createMetadataStore(dir),project=await store.createProject({path:dir,label:'Project A'});
 const conversation=await store.createConversation({projectId:project.id,title:'Chat'});
 await store.updateConversation(conversation.id,{modelPreference:'INITIAL',ownership:'managed',state:'idle'});
 const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}}),init=await auth.initAuth();
 await auth.authenticate(init.setupToken!);const setup=auth.createSession(true);
 const password='audit-only-password-123';await auth.completePasswordSetup(password,setup.token);
 let cookie=`__Host-caw_session=${setup.token}`;
 const config:any={host:'127.0.0.1',port:8791,stateDir:dir,allowedRoots:[dir],relayPort:8792,relayAllowedOrigins:[],maxActiveAgents:3,authTokenTtlHours:720,trustTailscaleOrigin:false,logLevel:'silent',insecureCookies:false};
 const app=buildApp({config,auth,store,originAllowlist:['https://workspace.test']});
 const responseGate=deferred(),arrivals:Array<{model:string,session:string,status:number}>=[];let held=false;
 vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,options:RequestInit={})=>{
  const url=String(input),requestCookie=cookie,headers={...options.headers as any,cookie:requestCookie,origin:'https://workspace.test'};
  const res=await app.inject({method:(options.method??'GET') as any,url,headers,...(options.body?{payload:String(options.body)}:{})});
  const setCookie=res.headers['set-cookie'];if(setCookie)cookie=(Array.isArray(setCookie)?setCookie[0]!:setCookie).split(';')[0]!;
  if(url.endsWith('/model')&&options.method==='PATCH'){
   const model=JSON.parse(String(options.body)).model;
   arrivals.push({model,session:requestCookie===`__Host-caw_session=${setup.token}`?'old':'new',status:res.statusCode});
   if(!held){held=true;await responseGate.promise;}
  }
  return new Response(res.body,{status:res.statusCode,headers:{'content-type':'application/json'}});
 }));
 // No agent/real socket is launched. These read-only capabilities are controlled;
 // App, views, mutation queue, real API/CSRF, auth routes and metadata store run.
 vi.spyOn(api,'getConversationLink').mockResolvedValue({ok:false,error:{code:'link_unavailable',message:'No live host'}});
 vi.spyOn(api,'getModels').mockResolvedValue({ok:true,data:{models:[],source:'unavailable',reason:'No agent'}});
 vi.spyOn(api,'listNativeSessions').mockResolvedValue({ok:true,data:[]});
 vi.spyOn(api,'getRuntime').mockResolvedValue({ok:false,error:{code:'internal',message:'No runtime'}});
 const openChat=async()=>{fireEvent.click(await screen.findByRole('heading',{name:'Project A'}));fireEvent.click(await screen.findByText('Chat'));await screen.findByText('Preferred for next launch:');fireEvent.click(screen.getByText('Conversation model settings'));};
 const save=(model:string)=>{fireEvent.change(screen.getByLabelText('Custom model ID'),{target:{value:model}});fireEvent.click(screen.getByRole('button',{name:'Save model'}));};
 try{
  render(<App/>);await openChat();save('OLD_FIRST');await waitFor(()=>expect(arrivals).toHaveLength(1));
  fireEvent.click(screen.getByTitle('Back'));fireEvent.click(await screen.findByText('Chat'));await screen.findByText('Preferred for next launch:');fireEvent.click(screen.getByText('Conversation model settings'));
  save('OLD_QUEUED');await act(async()=>{await Promise.resolve();});expect(arrivals).toHaveLength(1);
  if(rotate){
   fireEvent.click(screen.getByTitle('Back'));fireEvent.click(await screen.findByTitle('Back to projects'));fireEvent.click(await screen.findByTitle('Settings'));
   fireEvent.click(await screen.findByRole('button',{name:'Sign out'}));await screen.findByRole('button',{name:'Sign in'});
   fireEvent.change(screen.getByLabelText('Password'),{target:{value:password}});fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
   await openChat();save('NEW_FINAL');await screen.findByText('Model saved for next launch.');
   expect((await store.getConversation(conversation.id))!.modelPreference).toBe('NEW_FINAL');
  }
  await act(async()=>responseGate.resolve());
  // Pump real macrotasks before asserting: a retired intent that *did* get sent would
  // complete its fetch round trip asynchronously, and the acceptance assertions below
  // must observe it rather than race it.
  for(let i=0;i<30;i++)await act(async()=>{await new Promise((r)=>setTimeout(r,5));});
  const persisted=(await store.getConversation(conversation.id))!.modelPreference;
  console.log('AUDIT26 auth queue',JSON.stringify({rotate,arrivals,persisted}));
  if(rotate){
   // The intent recorded in the old session's dialog is retired at the boundary, so
   // the only writes to reach the server are the two the user actually submitted a
   // first request for — and only the new session's save decides the stored value.
   expect(arrivals.map(a=>a.model)).toEqual(['OLD_FIRST','NEW_FINAL']);
   expect(arrivals.every(a=>a.status===200)).toBe(true);
   expect(arrivals.filter(a=>a.session==='new').map(a=>a.model)).toEqual(['NEW_FINAL']);
   expect(persisted).toBe('NEW_FINAL');
   // The retired save reported nothing: whatever message is on screen came from the
   // new session's own successful save.
   expect(screen.queryByText('Model saved for next launch.')).not.toBeNull();
  }else{
   // Same-session guard: nothing is retired, so the recorded intent is still sent and
   // the last one the user asked for in this session wins.
   expect(arrivals.map(a=>a.model)).toEqual(['OLD_FIRST','OLD_QUEUED']);
   expect(persisted).toBe('OLD_QUEUED');
  }
 }finally{responseGate.resolve();cleanup();await app.close();await rm(dir,{recursive:true,force:true});}
});
