import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DefaultNativeSessionCatalog, encodeSessionDirName } from '../../packages/omp-adapter/src/session-catalog.js';
import { createRuntimeSpec } from '../../apps/server/src/server.js';
import { WorkspacePathPolicy } from '../../apps/server/src/path-policy.js';

it.each([false,true])('V23 listForCwd must filter journal cwd even when native buckets collide (collision=%s)',async collision=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-bucket-'));
 try{
  const first=join(dir,'a-b'),second=join(dir,collision?'a/b':'other');
  await mkdir(first,{recursive:true});await mkdir(second,{recursive:true});
  const sessions=join(dir,'sessions');
  for(const [cwd,id,date] of [[first,'first','2026-01-01'],[second,'second','2026-02-01']]){
   const bucket=join(sessions,encodeSessionDirName(cwd!));await mkdir(bucket,{recursive:true});
   await writeFile(join(bucket,`${date}_${id}.jsonl`),JSON.stringify({type:'session',id,cwd,timestamp:date})+'\n');
  }
  const catalog=new DefaultNativeSessionCatalog({sessionsRoot:sessions,leaseProbe:{isLive:async()=>false,liveSet:async()=>new Map(),leaseName:(id)=>id}});
  const list=await catalog.listForCwd(first);
  console.log('AUDIT23 bucket',JSON.stringify({collision,bucketEqual:encodeSessionDirName(first)===encodeSessionDirName(second),ids:list.map(s=>s.sessionId)}));
  // The resume boundary still protects the actual writer: the finding is a
  // misleading native-session list, not a demonstrated cross-project launch.
  const spec=createRuntimeSpec({store:{listProjects:async()=>[{id:'p',path:first}]},paths:new WorkspacePathPolicy([dir]),catalog});
  await expect(spec({projectId:'p'} as any,{resumeSessionId:'second'})).rejects.toMatchObject({code:'path_forbidden'});
  expect(list.map(s=>s.sessionId)).toEqual(['first']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('V23 canonical cwd alias retains its own journals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-alias-'));
 try{
  const cwd=join(dir,'project'),alias=join(dir,'alias'),sessions=join(dir,'sessions');
  await mkdir(cwd);await symlink(cwd,alias);
  const bucket=join(sessions,encodeSessionDirName(cwd));await mkdir(bucket,{recursive:true});
  await writeFile(join(bucket,'2026-01-01_own.jsonl'),JSON.stringify({type:'session',id:'own',cwd:alias})+'\n');
  const catalog=new DefaultNativeSessionCatalog({sessionsRoot:sessions,leaseProbe:{isLive:async()=>false,liveSet:async()=>new Map(),leaseName:(id)=>id}});
  expect((await catalog.listForCwd(cwd)).map(s=>s.sessionId)).toEqual(['own']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
