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

// Node 20.19 has no Promise.withResolvers; keep the tiny local deferred.
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};

/**
 * F-B1: the tail reload and backward paging shared one error/loading state, so a
 * tail reload that started FIRST but landed LAST replaced the rows a page had
 * just prepended — dropping the seq range between the two windows and leaving the
 * cursor unable to reach it. The two reads are held here so their landing order
 * is exactly the reviewer's probe: tail first, page second.
 */
it('V23 a tail restart cannot overwrite a page loaded while it was in flight (450 events)',async()=>{
 const total=450;const {conversation,teardown}=await setup(total);
 try{
  const real=vi.mocked(api.getConversationEvents).getMockImplementation()!;
  const held:{d:{resolve:(v:any)=>void};v:any}[]=[];
  let holdNext=0;
  vi.mocked(api.getConversationEvents).mockImplementation((id,options)=>{
   const result=real(id,options);
   if(holdNext<=0)return result;
   holdNext--;
   const d=deferred();
   void result.then(v=>{held.push({d,v});});
   return d.promise;
  });
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  await screen.findAllByText(/Older Event|Latest Problem/);
  await clickOlder();
  const walked=renderedSeqs(view.container);
  expect(walked[0]).toBe(450);
  expect(walked.at(-1)).toBe(251);
  // The next backward page fails, which is the only way the tail Retry appears.
  vi.mocked(api.getConversationEvents).mockImplementationOnce(async()=>({ok:false,error:{code:'internal',message:'older page failed'}}));
  await clickOlder();
  await screen.findByRole('alert');
  holdNext=2;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry'})));
  await clickOlder();
  await waitFor(()=>expect(held).toHaveLength(2));
  // Tail restart first, the page it raced second — the reviewer's ordering.
  await act(async()=>{held[0]!.d.resolve(held[0]!.v);});
  await act(async()=>{held[1]!.d.resolve(held[1]!.v);});
  const seqs=renderedSeqs(view.container);
  const unique=[...new Set(seqs)];
  console.log('AUDIT23 concurrent tail/paging',JSON.stringify({count:seqs.length,unique:unique.length,top:seqs[0],bottom:seqs.at(-1)}));
  expect(seqs.length).toBe(300);
  expect(unique.length).toBe(300);
  expect(seqs[0]).toBe(450);
  expect(seqs.at(-1)).toBe(151);
  expect(unique).toEqual(descending(450,151));
 }finally{await teardown();}
},30000);

/**
 * F-B2: a conversation switch used to keep the previous conversation's rows and
 * let a late response repaint them. The panel must start blank for the new id and
 * drop anything still in flight for the old one.
 */
it('V23 a conversation switch clears the previous rows and drops its late read',async()=>{
 const {store,conversation,teardown}=await setup(5);
 try{
  const project=await store.createProject({path:'/tmp/other'});
  const other=await store.createConversation({projectId:project.id});
  for(let i=1;i<=3;i++)await store.recordEvent(other.id,'other.event',{n:i});
  const real=vi.mocked(api.getConversationEvents).getMockImplementation()!;
  const held:{d:{resolve:(v:any)=>void};v:any}[]=[];
  let holdNext=1;
  vi.mocked(api.getConversationEvents).mockImplementation((id,options)=>{
   const result=real(id,options);
   if(holdNext<=0)return result;
   holdNext--;
   const d=deferred();
   void result.then(v=>{held.push({d,v});});
   return d.promise;
  });
  const view=render(<ActivityPanel conversationId={conversation.id}/>);
  await waitFor(()=>expect(held).toHaveLength(1));
  view.rerender(<ActivityPanel conversationId={other.id}/>);
  await screen.findAllByText('Other Event');
  const underB=renderedSeqs(view.container);
  await act(async()=>{held[0]!.d.resolve(held[0]!.v);});
  const afterLate=renderedSeqs(view.container);
  console.log('AUDIT23 activity switch',JSON.stringify({underB,afterLate}));
  expect(underB).toEqual([3,2,1]);
  expect(afterLate).toEqual([3,2,1]);
 }finally{await teardown();}
},30000);
