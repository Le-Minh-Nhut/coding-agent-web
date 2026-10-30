import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it,expect,vi } from 'vitest';
import { DefaultNativeSessionCatalog,encodeSessionDirName } from '../../packages/omp-adapter/src/session-catalog.js';
const fault=vi.hoisted(()=>({path:'',code:''}));
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>();
 return {...actual,realpathSync:(...args:Parameters<typeof actual.realpathSync>)=>{
  if(String(args[0])===fault.path&&fault.code)throw Object.assign(new Error('Injected cwd resolution error'),{code:fault.code});
  return (actual.realpathSync as any)(...args);
 }};
});
it.each(['none','EACCES','EIO'] as const)('V24 an unreadable own-session cwd must not become an empty list (%s)',async code=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r24-cwd-'));
 try{
  const cwd=join(dir,'project'),alias=join(dir,'old-alias'),sessions=join(dir,'sessions');
  await mkdir(cwd);await symlink(cwd,alias);
  const bucket=join(sessions,encodeSessionDirName(cwd));await mkdir(bucket,{recursive:true});
  await writeFile(join(bucket,'2026-01-01_own.jsonl'),JSON.stringify({type:'session',id:'own',cwd:alias})+'\n');
  const catalog=new DefaultNativeSessionCatalog({sessionsRoot:sessions,leaseProbe:{isLive:async()=>false,liveSet:async()=>new Map(),leaseName:id=>id}});
  fault.path=alias;fault.code=code==='none'?'':code;
  let ids:string[]|undefined,error:string|undefined;
  try{ids=(await catalog.listForCwd(cwd)).map(s=>s.sessionId);}catch(e){error=(e as NodeJS.ErrnoException).code;}
  console.log('AUDIT24 cwd error',JSON.stringify({code,ids,error}));
  if(code==='none')expect(ids).toEqual(['own']);else expect(error).toBe(code);
 }finally{fault.path='';fault.code='';await rm(dir,{recursive:true,force:true});}
});
