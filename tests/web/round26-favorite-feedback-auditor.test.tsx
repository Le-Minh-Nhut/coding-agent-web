// @vitest-environment jsdom
import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {App} from '../../apps/web/src/App.js';
import {api} from '../../apps/web/src/api.js';
import {resetMutationQueues} from '../../apps/web/src/mutation-order.js';
import {resetProjectMutationState} from '../../apps/web/src/components/ProjectsView.js';
vi.mock('../../apps/web/src/api.js',()=>({api:Object.fromEntries(['getMe','getCapabilities','getRuntime','listProjects','updateProject'].map(k=>[k,vi.fn()])),setCsrfToken:vi.fn()}));
afterEach(()=>{cleanup();resetMutationQueues();resetProjectMutationState();vi.restoreAllMocks();});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {resolve,promise};};
it.each([[false,false],[true,false],[false,true],[true,true]])('V26 favorite feedback survives remount=%s failure=%s',async(remount,failure)=>{
 let stored:any={id:'p',path:'/work',label:'Project A',favorite:false,conversationCount:0,lastActivityAt:null,createdAt:'',updatedAt:''};
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:'test'}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{}} as any);
 vi.mocked(api.getRuntime).mockResolvedValue({ok:false,error:{code:'internal',message:'No runtime'}});
 vi.mocked(api.listProjects).mockImplementation(async()=>({ok:true,data:[{...stored}]}));
 const gate=deferred();let completed=false;
 vi.mocked(api.updateProject).mockImplementation(async(_id,patch)=>{await gate.promise;completed=true;if(failure)return {ok:false,error:{code:'internal',message:'Favorite write refused'}};stored={...stored,...patch};return {ok:true,data:{...stored}};});
 render(<App/>);fireEvent.click(await screen.findByTitle('Star'));
 if(remount){fireEvent.click(screen.getByTitle('Settings'));fireEvent.click(await screen.findByRole('button',{name:'← Back'}));await screen.findByTitle('Star');}
 await act(async()=>{gate.resolve();});await waitFor(()=>expect(completed).toBe(true));
 const visibleFavorite=screen.queryByTitle('Unstar')!==null,error=screen.queryByRole('alert')?.textContent??null;
 console.log('AUDIT26 favorite feedback',JSON.stringify({remount,failure,storedFavorite:stored.favorite,visibleFavorite,error}));
 if(failure)expect(error??'').toContain('Favorite write refused');
 else{expect(stored.favorite).toBe(true);expect(visibleFavorite).toBe(true);}
});
