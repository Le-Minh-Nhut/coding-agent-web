// @vitest-environment jsdom
import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {SettingsView} from '../../apps/web/src/components/SettingsView.js';
import {api} from '../../apps/web/src/api.js';
vi.mock('../../apps/web/src/api.js',()=>({api:{getRuntime:vi.fn(),changePassword:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each([false,true])('V25 password response must not silently discard edits made while pending (edit=%s)',async edit=>{
 vi.mocked(api.getRuntime).mockResolvedValue({ok:false,error:{code:'internal',message:'No runtime fixture'}});
 let finish!:(v:any)=>void;vi.mocked(api.changePassword).mockReturnValue(new Promise(r=>finish=r));
 render(<SettingsView onBack={()=>{}} onLogout={()=>{}}/>);await screen.findByRole('button',{name:'Change password'});
 const current=screen.getByLabelText('Current password') as HTMLInputElement,newer=screen.getByLabelText('New password (12 characters minimum)') as HTMLInputElement;
 fireEvent.change(current,{target:{value:'old owner password'}});fireEvent.change(newer,{target:{value:'submitted password A'}});
 fireEvent.click(screen.getByRole('button',{name:'Change password'}));
 const editableDuringPending=!newer.disabled&&!newer.readOnly;
 if(edit&&editableDuringPending)fireEvent.change(newer,{target:{value:'unsaved password B'}});
 await act(async()=>finish({ok:true,data:{changed:true}}));
 const preserved=newer.value==='unsaved password B';
 console.log('AUDIT25 password form draft',JSON.stringify({edit,editableDuringPending,preserved,cleared:newer.value===''}));
 expect(!edit||!editableDuringPending||preserved).toBe(true);
});
