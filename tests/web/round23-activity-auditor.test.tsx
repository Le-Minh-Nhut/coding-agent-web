// @vitest-environment jsdom
import React from 'react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,act,waitFor } from '@testing-library/react';
import { createAuthenticationService } from '../../apps/server/src/auth.js';
import { createMetadataStore } from '../../apps/server/src/store.js';
import { buildApp } from '../../apps/server/src/app.js';
import { ActivityPanel } from '../../apps/web/src/components/ActivityPanel.js';
import { api } from '../../apps/web/src/api.js';
vi.mock('../../apps/web/src/api.js',()=>({api:{getConversationEvents:vi.fn()}}));
// Vitest rewrites import.meta.url to an http URL in jsdom. Only the static-asset
// root locator is adapted; auth, metadata store and events route are real.
vi.mock('../../apps/server/src/config.js',async importOriginal=>({...await importOriginal<any>(),findRepoRoot:()=>process.cwd()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});

/**
 * Real component → API bridge → Fastify events route → metadata store. Only the
 * api client is mocked (to route into app.inject) and the jsdom asset locator.
 */
async function setup(total:number){
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-activity-'));
 const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});await auth.initAuth();
 const store=createMetadataStore(dir);
 const project=await store.createProject({path:dir}),conversation=await store.createConversation({projectId:project.id});
 const addEvents=async(from:number,to:number)=>{for(let i=from;i<=to;i++)await store.recordEvent(conversation.id,i===total?'latest.problem':'older.event',{n:i});};
 await addEvents(1,total);
 const config:any={host:'127.0.0.1',port:8791,stateDir:dir,allowedRoots:[dir],relayPort:8792,relayAllowedOrigins:[],maxActiveAgents:3,authTokenTtlHours:720,trustTailscaleOrigin:false,logLevel:'silent',insecureCookies:false};
 const app=buildApp({config,auth,store,originAllowlist:['https://workspace.test']});
 const session=auth.createSession();
 vi.mocked(api.getConversationEvents).mockImplementation(async(id,options)=>{
  // V23-02 adaptation: the client now pages BACKWARD (`before`); the old mock only
  // forwarded `after`. Only this plumbing changed — the assertions are untouched.
  const query=options?.after!==undefined?`?after=${options.after}`:options?.before!==undefined?`?before=${options.before}`:'';
  return (await app.inject({method:'GET',url:`/api/conversations/${id}/events${query}`,headers:{cookie:`__Host-caw_session=${session.token}`}})).json();
 });
 const teardown=async()=>{cleanup();await app.close();await rm(dir,{recursive:true,force:true});};
 return {store,conversation,addEvents,teardown};
}
const descending=(from:number,to:number)=>Array.from({length:from-to+1},(_,i)=>from-i);
const renderedSeqs=(container:HTMLElement)=>[...container.querySelectorAll('.activity-item')].map((el)=>{const match=/^#(\d+)/.exec(el.querySelector('span[style*="0.75rem"]')?.textContent??'') ?? /#(\d+)/.exec(el.textContent??'');return Number(match?.[1]);});
const clickOlder=async()=>{const older=screen.queryByRole('button',{name:'Load older activity'});if(older)await act(async()=>fireEvent.click(older));return Boolean(older);};

it.each([0,99,100,101,250])('V23 activity opens on the newest events using real API/store (%s events)',async total=>{
 const {conversation,teardown}=await setup(total);
 try{
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  if(total===0){await screen.findByText('No activity recorded for this conversation yet.');}
  else await screen.findAllByText(/Older Event|Latest Problem/);
  const latestVisible=screen.queryByText('Latest Problem')!==null;
  const first=view.container.querySelector('.activity-item')?.textContent;
  const seqs=renderedSeqs(view.container);
  const older=screen.queryByRole('button',{name:'Load older activity'});
  console.log('AUDIT23 activity',JSON.stringify({total,latestVisible,first,seqs:seqs.slice(0,3),older:Boolean(older)}));
  if(total===0){expect(seqs).toEqual([]);expect(older).toBeNull();return;}
  // The newest event is visible on open, not hidden behind "Load older activity".
  expect(latestVisible).toBe(true);
  expect(seqs[0]).toBe(total);
  expect(seqs).toEqual([...seqs].sort((a,b)=>b-a));
  // "Load older" is only offered when there is genuinely older history.
  expect(older!==null).toBe(total>100);
 }finally{await teardown();}
},30000);

it('V23 walking every older page yields the whole timeline once, no gaps or duplicates (250 events)',async()=>{
 const total=250;const {conversation,teardown}=await setup(total);
 try{
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  await screen.findAllByText(/Older Event|Latest Problem/);
  let guard=0;
  while(await clickOlder()&&guard++<20){await waitFor(()=>expect(api.getConversationEvents).toHaveBeenCalledTimes(guard+1));}
  const seqs=renderedSeqs(view.container);
  const unique=[...new Set(seqs)];
  console.log('AUDIT23 walk pages',JSON.stringify({pages:guard,count:seqs.length,unique:unique.length,min:Math.min(...unique),max:Math.max(...unique)}));
  expect(seqs.length).toBe(total);
  expect(unique.length).toBe(total);
  expect(Math.min(...unique)).toBe(1);
  expect(Math.max(...unique)).toBe(total);
  expect(unique).toEqual(descending(total,1));
  expect(screen.queryByRole('button',{name:'Load older activity'})).toBeNull();
 }finally{await teardown();}
},30000);

it('V23 new events recorded while paging do not duplicate or shift the older pages',async()=>{
 const total=150;const {conversation,addEvents,teardown}=await setup(total);
 try{
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  await screen.findAllByText(/Older Event|Latest Problem/);
  const tail=renderedSeqs(view.container);
  expect(tail[0]).toBe(150);
  // Ten new events land after the tail was read. The panel keeps paging from the
  // cursor it holds; the loaded window stays gap-free and duplicate-free.
  await addEvents(151,160);
  await clickOlder();
  const seqs=renderedSeqs(view.container);
  const unique=[...new Set(seqs)];
  console.log('AUDIT23 new events during paging',JSON.stringify({tailTop:tail[0],count:seqs.length,unique:unique.length,min:Math.min(...unique)}));
  expect(seqs.length).toBe(unique.length);
  expect(Math.min(...unique)).toBe(1);
  expect(unique).toEqual(descending(150,1));
 }finally{await teardown();}
},30000);

it('V23 a failed activity read is an error with Retry, and the retry reloads the tail',async()=>{
 const total=120;const {conversation,teardown}=await setup(total);
 try{
  const real=vi.mocked(api.getConversationEvents).getMockImplementation()!;
  vi.mocked(api.getConversationEvents).mockResolvedValueOnce({ok:false,error:{code:'internal',message:'Activity store temporarily unavailable'}});
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  const alert=await screen.findByRole('alert');
  const emptyClaim=screen.queryByText('No activity recorded for this conversation yet.')!==null;
  console.log('AUDIT23 activity failure',JSON.stringify({alert:alert.textContent,emptyClaim,rendered:renderedSeqs(view.container).length}));
  expect(alert.textContent).toContain('temporarily unavailable');
  expect(emptyClaim).toBe(false);
  expect(renderedSeqs(view.container)).toEqual([]);
  vi.mocked(api.getConversationEvents).mockImplementation(real);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry'})));
  await screen.findAllByText(/Older Event|Latest Problem/);
  const seqs=renderedSeqs(view.container);
  expect(seqs[0]).toBe(total);
  expect(seqs).toEqual(descending(120,21));
  expect(screen.queryByRole('alert')).toBeNull();
 }finally{await teardown();}
},30000);

it('V23 the oldest page is reached with no gap after the tail, and the label goes older',async()=>{
 const total=101;const {conversation,teardown}=await setup(total);
 try{
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  await screen.findAllByText(/Older Event|Latest Problem/);
  const open=renderedSeqs(view.container);
  await clickOlder();
  const after=renderedSeqs(view.container);
  console.log('AUDIT23 label goes older',JSON.stringify({openTop:open[0],openBottom:open.at(-1),afterBottom:after.at(-1),afterTop:after[0],count:after.length}));
  // #101 is the newest and shown on open; the button brought the one older row in.
  expect(open[0]).toBe(101);
  expect(open.at(-1)).toBe(2);
  expect(after.at(-1)).toBe(1);
  expect(after.length).toBe(101);
  expect(screen.queryByRole('button',{name:'Load older activity'})).toBeNull();
 }finally{await teardown();}
},30000);
