import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAuthenticationService } from '../../apps/server/src/auth.js';
import { createMetadataStore } from '../../apps/server/src/store.js';
import { buildApp } from '../../apps/server/src/app.js';

/**
 * F-A2 test plumbing. The rotation window cannot be reached by racing real
 * wall-clock work: a login holds one scrypt and a password change holds two, so
 * the login always resumes first and the guard would look unnecessary. This
 * wrapper holds the FIRST scrypt for one nominated password until the test
 * releases it — the production window exactly (record read before the await, the
 * credential rewritten inside it, the comparison resumed after). The hook only
 * parks one callback per arm and every other scrypt in this file runs untouched.
 */
const scryptGate = vi.hoisted(() => ({
  armed: null as string | null,
  parked: [] as Array<() => void>,
}));
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    scrypt: (password: string, salt: unknown, keylen: number, callback: (error: Error | null, key: Buffer) => void) => {
      (original.scrypt as (...args: unknown[]) => void)(password, salt, keylen, (error: Error | null, key: Buffer) => {
        if (scryptGate.armed !== password) { callback(error, key); return; }
        scryptGate.armed = null;
        scryptGate.parked.push(() => callback(error, key));
      });
    },
  };
});

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

/**
 * F-A1: the requester's own EXPIRY inside the scrypt window must not make the
 * revocation of every other live session conditional. The pre-fix guard nested
 * `sessions.clear()` inside `sessions.get(key)===session && !expired`, so a
 * requester that merely expired left a second live session untouched while the
 * new credential was already on disk.
 *
 * Deterministic route to the window: the service takes an injectable `now`, and
 * a session's lifetime is a plain number on its record. A short TTL puts the
 * requester's expiry a few minutes out (still inside the 15-minute pending-token
 * window the setup path needs). The operation is started, and while it is parked
 * in its first scrypt await the clock is advanced past ONLY the requester's
 * expiry — its record is still in the map (the sweep only runs on verifySession),
 * so the pre-fix `sessions.get(key) === session && session.expiresAt > now()`
 * was false and `clear()` never ran.
 */
it.each(['change','setup'] as const)('V23 a password op whose requester expires in the window still revokes every other session (%s)',async kind=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-expiry-'));
 try{
  let clock=1_000_000;
  // 6-minute sessions: short enough to expire on demand, still inside the fixed
  // 15-minute pending-token TTL that the setup path validates against.
  const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{},ttlHours:0.1,now:()=>clock});
  const init=await auth.initAuth();
  expect(await auth.authenticate(init.setupToken!,'setup-ip')).toBe('setup');
  // The requester starts as a setup session (its flag is what completePasswordSetup
  // checks); the change case clears the flag by completing setup first.
  const requester=auth.createSession(true);
  if(kind==='change')expect(await auth.completePasswordSetup('original owner password',requester.token)).toBe('changed');
  clock+=60_000;
  // A second session created one minute later outlives the requester.
  const other=auth.createSession(false);
  expect(other.expiresAt).toBeGreaterThan(requester.expiresAt);
  const op=kind==='change'
   ?auth.changePassword('original owner password','replacement owner password',requester.token,'change-ip')
   :auth.completePasswordSetup('brand new owner password',requester.token);
  // Park the operation inside its scrypt await, then expire the requester. Its
  // record still sits in the map; `other` is untouched and still valid.
  clock=requester.expiresAt+1;
  expect(other.expiresAt).toBeGreaterThan(clock);
  const result=await op;
  const requesterRevoked=auth.verifySession(requester.token)===null;
  const otherAlive=auth.verifySession(other.token)!==null;
  console.log('AUDIT23 expiry-window revocation',JSON.stringify({kind,result,requesterRevoked,otherAlive}));
  expect(result).toBe(kind==='change' ? true : 'changed');
  expect(requesterRevoked).toBe(true);
  // The documented contract: every other live session is revoked. `other` is
  // still within its TTL, so the pre-fix coupling left it alive and usable.
  expect(otherAlive).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * F-A2: a login that authenticates against the OLD credential must not mint a
 * live session after a concurrent rotation.
 *
 * The window cannot be hit by racing wall-clock work — the login holds ONE scrypt
 * and the rotation holds TWO, so the login always finishes first. The gate below
 * holds the FIRST scrypt for a chosen password until the rotation has persisted,
 * which is exactly the production window: the record was read before the await,
 * the credential changes inside it, and the comparison resumes afterwards. The
 * mock is inert unless a test arms it, so every other test in this file runs the
 * real scrypt.
 */
it('V23 a login authenticated against the old credential cannot outrun a concurrent rotation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'caw-r23-rotate-'));
 try{
  const auth=createAuthenticationService({stateDir:dir,setupOutput:()=>{}});
  const init=await auth.initAuth();
  await auth.authenticate(init.setupToken!,'setup-ip');
  const session=auth.createSession(true);
  await auth.completePasswordSetup('original owner password',session.token);
  // Park the login's scrypt: its record is read, its hash not yet compared.
  scryptGate.armed='original owner password';
  const login=auth.authenticate('original owner password','login-ip');
  while(scryptGate.parked.length===0)await new Promise<void>((resolve)=>setImmediate(resolve));
  // The parked comparison is released only AFTER the rotation persisted the new
  // credential: the hash the login computed no longer belongs to the record.
  await auth.changePassword('original owner password','replacement owner password',session.token,'change-ip');
  for(const release of scryptGate.parked.splice(0))release();
  const result=await login;
  console.log('AUDIT23 stale-credential login',JSON.stringify({result}));
  expect(result).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
