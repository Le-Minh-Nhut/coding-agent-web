// @vitest-environment jsdom
import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {ProjectsView} from '../../apps/web/src/components/ProjectsView.js';
import {SettingsView} from '../../apps/web/src/components/SettingsView.js';
import {api} from '../../apps/web/src/api.js';
vi.mock('../../apps/web/src/api.js',()=>({api:{listProjects:vi.fn(),getRuntime:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each([false,true])('V25 a failed project list must not claim an empty workspace (failure=%s)',async failure=>{
 vi.mocked(api.listProjects).mockResolvedValue(failure?{ok:false,error:{code:'internal',message:'Project store unavailable'}}:{ok:true,data:[]});
 await act(async()=>render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>));
 const emptyClaim=screen.queryByText('No projects added yet.')!==null;
 console.log('AUDIT25 projects read failure',JSON.stringify({failure,emptyClaim,errorShown:screen.queryByRole('alert')?.textContent?.includes('Project store unavailable')}));
 expect(emptyClaim).toBe(!failure);
 if(failure)expect(screen.getByRole('alert').textContent).toContain('Project store unavailable');
});
it.each([false,true])('V25 runtime read failure must not report installed engines as Missing (failure=%s)',async failure=>{
 const runtime:any={activeCount:0,maxActive:3,capabilities:{omp:{available:true,version:'omp-test',path:'/stub/omp'},tmux:{available:true,version:'tmux-test'},relay:{configured:true,origin:'http://localhost',reachable:true}}};
 vi.mocked(api.getRuntime).mockResolvedValue(failure?{ok:false,error:{code:'internal',message:'Runtime status temporarily unavailable'}}:{ok:true,data:runtime});
 const view=render(<SettingsView onBack={()=>{}} onLogout={()=>{}}/>);
 await screen.findByRole('button',{name:'Change password'});
 const missingClaims=screen.queryAllByText('Missing').length;
 const errorShown=view.container.textContent?.includes('Runtime status temporarily unavailable')??false;
 console.log('AUDIT25 runtime read failure',JSON.stringify({failure,missingClaims,errorShown}));
 expect(missingClaims).toBe(0);
 if(failure)expect(errorShown).toBe(true);
});
