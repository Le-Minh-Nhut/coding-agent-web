import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAuthenticationService } from '../../apps/server/src/auth.js';
import { createMetadataStore } from '../../apps/server/src/store.js';
import { buildApp } from '../../apps/server/src/app.js';

it.each([false, true])('V23 password change must not resurrect a revoked session (revoke=%s)', async revoke => {
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-auth-'));
 try {
  const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});
  const init=await auth.initAuth();
  expect(await auth.authenticate(init.setupToken!, 'setup-ip')).toBe('setup');
  const current=auth.createSession(true);
  expect(await auth.completePasswordSetup('original owner password',current.token)).toBe('changed');
  const changing=auth.changePassword('original owner password','replacement owner password',current.token,'change-ip');
  if(revoke)auth.revokeAll();
  const revokedImmediately=auth.verifySession(current.token)===null;
  const changed=await changing;
  const resurrected=auth.verifySession(current.token)!==null;
  console.log('AUDIT23 password/revoke',JSON.stringify({revoke,revokedImmediately,changed,resurrected}));
  expect(resurrected).toBe(!revoke);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('V23 a confirmed HTTP logout stays revoked after an already-running password change',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-auth-http-'));
 const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});const init=await auth.initAuth();
 await auth.authenticate(init.setupToken!,'setup');const current=auth.createSession(true);
 await auth.completePasswordSetup('original owner password',current.token);
 let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 const realChange=auth.changePassword.bind(auth);
 // Observe entry without delaying or changing the real auth operation.
 auth.changePassword=(...args)=>{const pending=realChange(...args);entered();return pending;};
 const config:any={host:'127.0.0.1',port:8791,stateDir:dir,allowedRoots:[dir],relayPort:8792,relayAllowedOrigins:[],maxActiveAgents:3,authTokenTtlHours:720,trustTailscaleOrigin:false,logLevel:'silent',insecureCookies:false};
 const app=buildApp({config,auth,store:createMetadataStore(dir),originAllowlist:['https://workspace.test']});
 const headers={cookie:`__Host-caw_session=${current.token}`,origin:'https://workspace.test','x-caw-csrf':current.csrfToken};
 try{
  const changing=app.inject({method:'POST',url:'/api/auth/change-password',headers,payload:{currentPassword:'original owner password',newPassword:'replacement owner password'}}).then(r=>r);
  await started;
  const logout=await app.inject({method:'POST',url:'/api/auth/logout',headers});
  expect(logout.statusCode).toBe(200);
  const immediately=await app.inject({method:'GET',url:'/api/auth/me',headers});
  expect(immediately.statusCode).toBe(401);
  const change=await changing;
  const later=await app.inject({method:'GET',url:'/api/auth/me',headers});
  console.log('AUDIT23 HTTP revoke',JSON.stringify({logout:logout.statusCode,immediately:immediately.statusCode,change:change.statusCode,later:later.statusCode}));
  expect(later.statusCode).toBe(401);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

it.each([false, true])('V23 setup completion must not resurrect a revoked session (revoke=%s)', async revoke => {
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-setup-'));
 try {
  const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});
  const init=await auth.initAuth();
  expect(await auth.authenticate(init.setupToken!, 'setup-ip')).toBe('setup');
  const current=auth.createSession(true);
  const completing=auth.completePasswordSetup('new owner password',current.token);
  if(revoke)auth.revokeAll();
  const changed=await completing;
  const resurrected=auth.verifySession(current.token)!==null;
  console.log('AUDIT23 setup/revoke',JSON.stringify({revoke,changed,resurrected}));
  expect(resurrected).toBe(!revoke);
 }finally{await rm(dir,{recursive:true,force:true});}
});
