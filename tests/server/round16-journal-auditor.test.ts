import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMetadataStore } from "../../apps/server/src/store.js";
const dirs:string[]=[];
async function fixture(){const dir=await mkdtemp(join(tmpdir(),"caw-audit16-"));dirs.push(dir);return {dir,file:join(dir,"metadata.jsonl"),store:createMetadataStore(dir)};}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

it("V16 load retry: a repaired journal must replay into a clean state",async()=>{
 const {dir,file,store}=await fixture();const p=await store.createProject({path:"/work/a"});const c=await store.createConversation({projectId:p.id});await store.recordEvent(c.id,"audit.event",{});
 const valid=await readFile(file,"utf8");await appendFile(file,"{bad complete row}\n");
 const retrying=createMetadataStore(dir);await expect(retrying.listProjects()).rejects.toThrow();
 await writeFile(file,valid);
 await retrying.listProjects();const events=await retrying.listEvents(c.id);
 console.log("AUDIT16 repaired load",JSON.stringify({eventCount:events.length,sequences:events.map(e=>e.seq)}));
 expect(events).toHaveLength(1);
});

it("V16 EOF Unicode: an intentional replacement character in valid UTF-8 is not corruption",async()=>{
 const {dir,file,store}=await fixture();const p=await store.createProject({path:"/work/unicode",label:"Pasted � character"});const bytes=await readFile(file);await writeFile(file,bytes.subarray(0,-1));
 const restored=await createMetadataStore(dir).listProjects();
 console.log("AUDIT16 valid replacement character",JSON.stringify({before:p,restored}));
 expect(restored).toEqual([p]);
});

it("V16 delete transaction: a torn cascade delete must not partially remove conversations",async()=>{
 const {dir,file,store}=await fixture();const p=await store.createProject({path:"/work/atomic"});const a=await store.createConversation({projectId:p.id});const b=await store.createConversation({projectId:p.id});
 // Disk state possible when a process exits mid-write: the cascade is ONE journal
 // record, so a torn write is a truncated line at EOF and no caller gets success.
 // (The probe used to spell this as one complete `conversation-delete` row plus an
 // incomplete second one — the multi-row shape the old writer produced. That shape
 // is no longer emitted: a whole project delete is one `project-cascade-delete`
 // record. End-state assertion is unchanged.)
 await appendFile(file,JSON.stringify({op:"project-cascade-delete",id:p.id,conversationIds:[a.id,b.id]}).slice(0,32));
 const reopened=createMetadataStore(dir);const projects=await reopened.listProjects();const conversations=await reopened.listConversations(p.id);
 console.log("AUDIT16 torn multi-delete",JSON.stringify({projectExists:projects.some(row=>row.id===p.id),conversationIds:conversations.map(row=>row.id),expected:[a.id,b.id]}));
 expect(conversations.map(row=>row.id)).toEqual([a.id,b.id]);
 expect(projects.some(row=>row.id===p.id)).toBe(true);
});

it("V16 delete transaction: a whole cascade delete record removes the project and every child",async()=>{
 const {dir,file}=await fixture();
 const store=createMetadataStore(dir);const p=await store.createProject({path:"/work/whole"});const a=await store.createConversation({projectId:p.id});const b=await store.createConversation({projectId:p.id});
 await createMetadataStore(dir).updateConversation(a.id,{state:"stopped"});
 await createMetadataStore(dir).updateConversation(b.id,{state:"stopped"});
 expect(await store.deleteProject(p.id,new Map([[a.id,0],[b.id,0]]))).toBe("deleted");
 const rows=(await readFile(file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
 expect(rows.at(-1)).toEqual({op:"project-cascade-delete",id:p.id,conversationIds:[a.id,b.id]});
 const reopened=createMetadataStore(dir);
 expect(await reopened.listProjects()).toEqual([]);
 expect(await reopened.listConversations(p.id)).toEqual([]);
});

it("V16 delete transaction: journals written before the cascade record still replay",async()=>{
 const {dir,file}=await fixture();const store=createMetadataStore(dir);
 const p=await store.createProject({path:"/work/legacy"});const c=await store.createConversation({projectId:p.id});
 await store.recordEvent(c.id,"audit.event",{});
 // The pre-cascade encoding: one `conversation-delete` row per child, then the
 // project row. Existing on-disk journals must keep loading.
 await appendFile(file,JSON.stringify({op:"conversation-delete",id:c.id})+"\n"+JSON.stringify({op:"project-delete",id:p.id})+"\n");
 const reopened=createMetadataStore(dir);
 expect(await reopened.listProjects()).toEqual([]);
 expect(await reopened.listConversations(p.id)).toEqual([]);
 expect(await reopened.listEvents(c.id)).toEqual([]);
});
